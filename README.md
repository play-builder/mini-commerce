# Mini Commerce

이 저장소는 PostgreSQL 기반 Mini Commerce production service의 Node.js 24 코드입니다.
상품 조회·재고 확인·idempotent 주문 생성과 canonical 주문 조회를 제공합니다.
CI는 ECR에 multi-architecture 이미지 인덱스를 푸시한 뒤 application과 migration image의
index digest를 `argocd-gitops` 저장소에 반영합니다.

## 전체 흐름

```text
application PR merge
        │
        ▼
lint + test → Buildx(amd64/arm64) → ECR index digest
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
             dev digest PR                         prod promotion PR
             validate + auto-merge                 CODEOWNERS approval
                   │                                     │
                   ▼                                     ▼
             Argo CD Deployment                    Argo Rollouts Canary
```

이 그림에서 봐야 할 핵심은 prod에서 새 이미지를 다시 빌드하지 않는다는 점입니다. dev에서
검증한 동일 digest를 복사해야 공급망과 승격 이력을 추적할 수 있습니다.

## 런타임 listener와 endpoint

| listener | 경로 | 역할 |
| --- | --- |
| business `PORT` (기본 `3000`) | `GET /products` | 상품 목록 |
| business `PORT` | `GET /products/:id/inventory` | 현재 재고 |
| business `PORT` | `POST /orders` | idempotency key를 사용하는 재고 차감·주문 transaction |
| business `PORT` | `GET /orders/:id` | PostgreSQL canonical order repository의 주문 조회 |
| management `MANAGEMENT_PORT` (기본 `3001`) | `GET /healthz`, `GET /readyz` | process liveness, readiness |
| management `MANAGEMENT_PORT` | `GET /metrics`, `GET /version` | Prometheus metrics, build metadata |

business listener는 관리 endpoint를 노출하지 않으며 management listener는 주문 API를 노출하지 않습니다.
`openapi/mini-commerce.v1.yaml`은 business의 네 operation만 문서화하는 파일 계약입니다. PR에서는 base
revision과 비교하는 compatibility verifier가 operation/응답 제거를 차단합니다.

DB가 활성화된 production process는 bounded startup check가 성공한 뒤 readiness를 올립니다. 이후 DB가
일시적으로 실패해도 startup-only policy는 이미 ready인 Pod를 내리지 않습니다. business request는 안전한
`503 {"error":"database unavailable"}`로 실패하며 driver 오류와 SQL은 응답에 포함하지 않습니다.
`READINESS_DEPENDENCY_POLICY=continuous`는 development/test에서만 명시적으로 사용할 수 있습니다.

## 로컬 검증

의존성은 lock 파일 그대로 설치합니다.

```bash
npm ci
npm run lint
npm test
bash test/curl-loop.test.sh
```

`dependency-review.yml`은 `package.json`, `package-lock.json`, 또는 dependency-review 정책 변경 PR에서
runtime dependency의 high 이상 취약점과 허용되지 않은 변경을 차단합니다. 이 검사는 GitHub dependency
graph와 private repository에 적용되는 GitHub Code Security entitlement가 필요합니다. 해당 capability가 없는
repository에서는 required check을 선택 사항으로 낮추지 말고 repository 설정을 먼저 충족해야 합니다.

애플리케이션 실행:

```bash
npm start
curl -fsS http://127.0.0.1:3001/readyz
curl -fsS http://127.0.0.1:3001/version
```

장애 응답을 생성할 때는 별도 shell에서 요청 부하를 유지합니다.

```bash
FAILURE_RATE=0.5 npm start
bash scripts/curl-loop.sh http://127.0.0.1:3000/ 2400 0.25
```

종료 시 애플리케이션은 먼저 readiness를 내리고 `SHUTDOWN_DELAY_MS` 동안 in-flight 요청을
기다린 뒤 종료합니다. Kubernetes의 `terminationGracePeriodSeconds`는 이 값보다 커야 합니다.

## Stateful Mini Commerce 로컬 실행

DB 기능은 기본적으로 꺼져 있으므로 기존 Stateless 실습 결과는 바뀌지 않습니다. 로컬 DB의
기본 host port는 다른 PostgreSQL과의 충돌을 줄이기 위해 `55432`입니다.

```bash
export DB_PASSWORD="$(openssl rand -hex 24)"
docker compose up -d --wait postgres
export DATABASE_ENABLED=true
export DB_HOST=127.0.0.1
export DB_PORT=55432
export DB_NAME=commerce
export DB_USER=commerce
npm run migrate:up
npm start
```

다른 terminal에서 세 비즈니스 동작을 확인합니다.

```bash
curl -fsS http://127.0.0.1:3000/products
curl -fsS http://127.0.0.1:3000/products/1/inventory
curl -fsS -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: course-order-001' \
  -d '{"items":[{"productId":1,"quantity":2}]}'
curl -fsS http://127.0.0.1:3000/orders/1
```

동일한 `Idempotency-Key`로 주문을 다시 보내면 새 주문을 만들거나 재고를 다시 차감하지 않고 기존
주문을 반환합니다. 주문 생성은 PostgreSQL transaction과 inventory row lock을 사용합니다.

Migration은 한 번 적용한 파일을 되돌리거나 수정하지 않는 forward-only 계약을 사용합니다.
`course_migration_ledger`가 적용 파일의 SHA-256을 기록하고, 동시 runner는 control row와
`node-pg-migrate` advisory lock으로 직렬화됩니다.

`002_expand_product_display_name.js`는 기존 `name`을 유지한 채 `display_name`을 추가하고
backfill합니다. 이 Expand 구간에서는 v1과 v2 application query가 같은 schema에서 함께
동작해야 합니다.

`v2.0.1-hotfix-order-total` release는 수량 4개 이상인 주문의 합계도 `단가 × 수량`으로
계산합니다. 이 regression은 공개 fault endpoint나 runtime flag가 아니라 별도 source commit으로
재현합니다.

`003_contract_product_name.js`는 모든 retained rollback candidate가 `v2prime` query contract를
사용하는지 확인한 뒤 적용하는 Contract 단계입니다. `display_name` null gate를 통과해야만
`NOT NULL`을 설정하고 legacy `name`을 제거합니다. Rollback window 판정은 revision 번호 차이가
아니라 target과 stable 사이에 실제 남아 있는 non-Experiment ReplicaSet 수를 사용합니다.
Migration Job은 GitOps runtime checker가 만든 `course.rollback-candidates/v1` JSON 경로를
`ROLLBACK_CANDIDATES_FILE`로 받아야 합니다. 각 candidate의 image digest, source revert SHA,
Rollout revision, Pod template hash와 `productReadContract=v2prime`을 검증하고, 입력 파일 SHA-256을
`course_migration_contract_gate`에 기록한 뒤에만 Contract 003을 실행합니다.

```bash
docker compose down --volumes
```

`--volumes`는 로컬 실습 DB를 삭제합니다. 보존할 데이터가 있는 Compose project에는 실행하지
않습니다.

## Evidence와 dependency-review 경계

Release evidence v2는 mutable `owner/repository` display text 대신 GitHub numeric `repositoryId`를 사용합니다.
workflow API의 `repository.id`와 evidence ID가 일치해야 하므로 repository rename은 허용하지만 같은 이름을
가진 다른 repository는 거부합니다. v1 evidence는 migration window 동안 canonical ID `1352247019`에 한해
validator 입력으로만 허용되며, 새 emitter는 v2만 작성합니다. ECR repository identity는 별도로 검증합니다.

아래 로컬 명령은 static, unit, 또는 container 수준의 검증일 뿐 GitHub Actions required check, ingress
listener 차단, managed PostgreSQL 장애, AMP/trace export, 또는 cloud rollout을 증명하지 않습니다.

```bash
node --test test/openapi-contract.test.js test/repository-identity-migration.test.js
node scripts/verify-openapi-backward-compatibility.mjs \
  --base-ref 0f6e4ce79e102054fa63c8d07b53f24dbdbb4d \
  --bootstrap-base-sha 0f6e4ce79e102054fa63c8d07b53f24dbdbb4d \
  --candidate openapi/mini-commerce.v1.yaml
```

## Container image 계약

Dockerfile은 Node `24.20.0-alpine3.23`의 multi-architecture index digest로 base image를
고정합니다. 로컬 단일 아키텍처 확인은 다음과 같습니다.

```bash
docker build \
  --build-arg APP_VERSION=local \
  --build-arg GIT_SHA=local \
  --build-arg BUILD_DATE=2026-09-01T00:00:00Z \
  -t mini-commerce:local .
```

CI에서는 `linux/amd64,linux/arm64`를 동시에 push하며 action 출력의 digest를 다시 inspect합니다.

## Bounded load와 release evidence

`load/k6-baseline.js`는 명시한 Dev host의 HTTPS origin만 허용하며 초당 1~20회, 30~300초 범위의
`constant-arrival-rate`만 실행합니다. path·query·credential·비표준 port가 포함된 URL과 운영
endpoint, 공개 fault endpoint는 거부합니다.

```bash
TARGET_ENV=dev TARGET_URL="https://dev.example.com" \
EXPECTED_DEV_HOST="dev.example.com" RATE_PER_SECOND=5 DURATION_SECONDS=60 \
k6 run load/k6-baseline.js
```

부하 실행 뒤 invariant verifier는 application과 같은 `DATABASE_ENABLED`·`DB_*` 계약으로 DB에
접속해 주문·주문 항목 수와 FK 위반, 중복 idempotency key, 음수 재고를 확인합니다.

```bash
DATABASE_ENABLED=true DB_HOST="127.0.0.1" DB_PORT=5432 DB_NAME="commerce" \
DB_USER="commerce" DB_PASSWORD="[secret]" DB_SSL=false \
node scripts/verify-commerce-invariants.mjs
```

`scripts/export-release-evidence.mjs`는 source/run/image/attestation, Dev·Prod GitOps revision,
Argo·Rollout·AnalysisRun·SLO, rollback candidate와 cleanup 결과를 `course.release-evidence/v1`
canonical JSON으로 묶습니다. 최종 record는 만료되는 현재 상태가 아니라 보존할 audit artifact이므로
`INCIDENT_EVIDENCE`, 관측 시각, DEV_READY·Prod baseline·Prod SLO·incident index의 SHA-256을
기록합니다. 이 스크립트는 전달받은 증거를 검증·직렬화할 뿐 cloud 실행이나 cleanup을 수행하지
않습니다.

```bash
docker buildx imagetools inspect \
  <account>.dkr.ecr.<region>.amazonaws.com/playdevops/mini-commerce@sha256:<digest>
```

정상 결과에는 `linux/amd64`와 `linux/arm64` platform manifest가 모두 보여야 합니다.

## GitHub repository 설정

Repository variables:

| 이름 | 값 |
| --- | --- |
| `AWS_REGION` | `us-east-1` 또는 `ap-northeast-2` |
| `AWS_ROLE_ARN` | EKS-infra의 `sample_app_push_role_arn` 출력 |
| `AWS_ATTEST_VERIFY_ROLE_ARN` | EKS-infra의 supply-chain read/verify Role ARN 출력 |
| `ECR_REPOSITORY` | `playdevops/mini-commerce` |
| `GITOPS_APP_ID` | GitOps용 GitHub App ID |
| `GITOPS_OWNER` | GitOps 저장소 owner |
| `GITOPS_REPOSITORY_NAME` | GitOps 저장소 이름 |

GitOps environment secrets:

| Environment | 이름 | 값 |
| --- | --- | --- |
| `gitops-dev-delivery` | `GITOPS_APP_PRIVATE_KEY` | GitHub App private key PEM 전체 |
| `gitops-production` | `GITOPS_APP_PRIVATE_KEY` | GitHub App private key PEM 전체 |

`GITOPS_APP_PRIVATE_KEY`는 repository secret이 아니라 GitHub의
gitops-dev-delivery environment secret과 gitops-production environment secret으로 각각
등록합니다. PEM을 화면에 출력하지 않고 등록하는 명령은 다음과 같습니다.

```bash
gh secret set GITOPS_APP_PRIVATE_KEY --env gitops-dev-delivery \
  --repo "<owner>/mini-commerce" < "<GitHub-App-private-key.pem>"

gh secret set GITOPS_APP_PRIVATE_KEY --env gitops-production \
  --repo "<owner>/mini-commerce" < "<GitHub-App-private-key.pem>"
```

두 environment의 deployment branch를 `main`으로 제한합니다. `gitops-dev-delivery`는 main CI의
자동 Dev 전달용이므로 required reviewer를 두지 않습니다. `gitops-production`은 해당 GitHub 요금제와
repository visibility에서 protection rule을 지원하면 실행자와 다른 운영 담당자를 required reviewer로
지정합니다. 기존 repository-level `GITOPS_APP_PRIVATE_KEY`가 있다면 두 environment secret 등록을
확인한 뒤 삭제합니다. 이 경계로 인해 다른 ref에서는 credential을 읽을 수 없고, Prod promotion은
승인 전에는 private key를 읽지 못합니다.

교육 환경에서는 같은 GitHub App credential을 두 environment에 저장할 수 있습니다. 다만 main
workflow가 침해되었을 때 credential 자체를 Dev와 Prod 사이에서 격리해야 하는 조직은 별도 GitHub App을
사용해 App ID와 private key를 분리합니다. 어느 방식이든 GitHub App을 Ruleset bypass actor로 지정하지
않고 CODEOWNERS와 required status check를 그대로 통과시킵니다.

GitHub App은 `argocd-gitops` 저장소에 설치하고 최소한 다음 repository permission을 줍니다.

- Contents: Read and write
- Pull requests: Read and write

`ci.yml`의 AWS 접근은 장기 access key가 아니라 GitHub OIDC를 사용합니다. Trust policy는
`main`과 `dev` branch ref만 허용하며 PR workflow에는 AWS 권한이 없습니다.

## Workflow 책임

Dev delivery는 application build와 검증 job의 AWS session을 공유하지 않습니다. Build 이후
`attest-and-verify`가 별도의 OIDC Role로 ECR에 로그인하고, `linux/amd64`와 `linux/arm64`
child manifest를 각각 Trivy로 검사합니다. GitHub build attestation과 ECR OCI referrer가 동일한
index digest를 가리킬 때만 GitOps update job으로 넘어갑니다.

CI는 검증된 supply-chain evidence artifact까지만 보관합니다. Dev 배포 뒤 EKS-infra runtime
checker와 SLO gate가 각각 GitOps 저장소에 기록한 deployment·SLO evidence를 promotion workflow가
exact CI run의 supply-chain evidence와 교차 검증해 canonical DEV_READY를 조립합니다.
`publish-dev-ready` 실행은 이 증거 파일만 PR로 게시하며 Prod image를 바꾸지 않습니다.
증거 PR이 merge된 뒤 `promote-candidate`를 실행하면 동일 입력에서 다시 만든 canonical bytes가
게시된 증거와 정확히 같은지 확인하고, 별도로 기록한 Prod runtime baseline과 digest·cluster
identity가 다른 경우에만 Prod values 변경 PR을 생성합니다.

```text
schemaVersion, environment, region, sourceSha, workflow, image,
attestation, gitops, cluster, slo, issuedAt, expiresAt
```

root key를 평탄화하거나 이름을 바꾼 evidence는 호환 대상으로 처리하지 않습니다.

| 파일 | 실행 시점 | 결과 |
| --- | --- | --- |
| `.github/workflows/test.yml` | application PR | lint, unit test, PostgreSQL transaction test, image build |
| `.github/workflows/ci.yml` | `main` push | ECR push, Dev app·migration digest PR, validation 후 auto-merge |
| `.github/workflows/promote.yml` | 수동 dispatch | DEV_READY 게시 PR 또는 검증된 Prod values 승인 PR |

GitHub App token의 push가 GitOps validate workflow를 한 번 실행하는 것은 정상입니다. 자동화가
같은 digest를 다시 쓰지 않도록 `gitops-values.mjs`가 idempotent하게 동작하므로 무한 trigger
loop가 생기지 않습니다. `envs/dev/**`를 `paths-ignore`하거나 `[skip ci]`로 validation을
우회하지 않습니다.

## 정상 결과와 실패 확인

정상 CI 결과:

- `npm ci`, lint, test 모두 성공
- ECR image가 immutable tag와 index digest를 가짐
- Dev PR diff는 `envs/dev/values.yaml`의 application·migration repository/digest만 변경함
- Prod promotion은 Dev에서 검증한 두 digest를 그대로 사용함
- Fix-Backward는 application digest만 되돌리고 적용된 backward-compatible schema는 유지함

주요 실패 원인:

- `AccessDenied`: `AWS_ROLE_ARN`, OIDC subject, ECR push policy 확인
- `ImageTagAlreadyExistsException`: 재실행 tag에 run ID/attempt가 포함됐는지 확인
- `ImagePullBackOff`: index digest인지와 worker node role의 ECR pull policy 확인
- GitOps PR 생성 실패: GitHub App 설치 대상과 Contents/PR permission 확인

버전 계약은 [versions.lock.yaml](./versions.lock.yaml)에 있으며, 배포 manifest는 이 저장소가
아니라 `argocd-gitops`에서 관리합니다.
