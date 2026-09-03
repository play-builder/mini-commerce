# CI/CD course sample application

이 저장소는 CI/CD와 GitOps 강의에서 빌드·테스트·배포할 Node.js 24 애플리케이션의 전체
코드입니다. Ch01~Ch14에서는 기존 Stateless 운영 endpoint를 사용하고, 그 이후 Stateful 보충
실습에서는 PostgreSQL 기반 Mini Commerce의 상품 조회·재고 확인·주문 생성을 활성화합니다.
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

## 엔드포인트와 장애 주입

| 경로 | 역할 |
| --- | --- |
| `GET /` | 버전 응답, `FAILURE_RATE`와 `LATENCY_MS` 적용 |
| `GET /healthz` | liveness probe |
| `GET /readyz` | readiness probe |
| `GET /version` | digest와 연결할 build metadata 확인 |
| `GET /config` | secret 값은 숨기고 키 존재 여부·길이만 반환 |
| `GET /metrics` | AMP로 수집할 Prometheus metrics |
| `GET /products` | Stateful 모드의 mock 상품·재고 목록 |
| `GET /products/:id/inventory` | 상품 한 개의 현재 재고 |
| `POST /orders` | 멱등성 key를 사용하는 재고 차감·주문 transaction |
| `GET /db/status` | PostgreSQL 연결 상태 |

`FAILURE_RATE`는 `/`에만 적용됩니다. Probe까지 실패시키면 카나리 분석이 아니라
`CrashLoopBackOff` 실습이 되므로 의도적으로 분리했습니다.

## 로컬 검증

의존성은 lock 파일 그대로 설치합니다.

```bash
npm ci
npm run lint
npm test
bash test/curl-loop.test.sh
```

애플리케이션 실행:

```bash
npm start
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS http://127.0.0.1:3000/version
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
docker compose up -d --wait postgres
export DATABASE_ENABLED=true
export DB_HOST=127.0.0.1
export DB_PORT=55432
export DB_NAME=commerce
export DB_USER=commerce
export DB_PASSWORD=course-local-only
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

`/readyz`는 Stateful 모드에서 DB query도 검사합니다. 이는 migration 전 application 유입을
막는 데 유용하지만, DB 장애가 모든 Pod를 endpoint에서 제거할 수 있으므로 실제 운영에서는 timeout,
grace period, dependency별 health 정책을 서비스 특성에 맞게 조정해야 합니다.

## Container image 계약

Dockerfile은 Node `24.20.0-alpine3.23`의 multi-architecture index digest로 base image를
고정합니다. 로컬 단일 아키텍처 확인은 다음과 같습니다.

```bash
docker build \
  --build-arg APP_VERSION=local \
  --build-arg GIT_SHA=local \
  --build-arg BUILD_DATE=2026-09-01T00:00:00Z \
  -t sample-app:local .
```

CI에서는 `linux/amd64,linux/arm64`를 동시에 push하며 action 출력의 digest를 다시 inspect합니다.

```bash
docker buildx imagetools inspect \
  <account>.dkr.ecr.<region>.amazonaws.com/playdevops/sample-app@sha256:<digest>
```

정상 결과에는 `linux/amd64`와 `linux/arm64` platform manifest가 모두 보여야 합니다.

## GitHub repository 설정

Repository variables:

| 이름 | 값 |
| --- | --- |
| `AWS_REGION` | 예: `us-east-1` |
| `AWS_ROLE_ARN` | EKS-infra의 `sample_app_push_role_arn` 출력 |
| `AWS_ATTEST_VERIFY_ROLE_ARN` | EKS-infra의 supply-chain read/verify Role ARN 출력 |
| `ECR_REPOSITORY` | `playdevops/sample-app` |
| `DEV_CLUSTER_ARN` | Dev EKS cluster ARN |
| `DEV_SLO_EVIDENCE_ID` | Dev SLO 검증 결과의 immutable evidence ID |
| `GITOPS_APP_ID` | GitOps용 GitHub App ID |
| `GITOPS_OWNER` | GitOps 저장소 owner |
| `GITOPS_REPOSITORY_NAME` | GitOps 저장소 이름 |

Repository secret:

| 이름 | 값 |
| --- | --- |
| `GITOPS_APP_PRIVATE_KEY` | GitHub App private key PEM 전체 |

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

배포가 끝나면 CI는 supply-chain artifact를 다음 canonical root schema로 매핑해
`dev-ready-<run-id>-<attempt>` artifact로 보관합니다. promotion workflow는 CI run ID와 attempt로
그 artifact를 직접 내려받고, 만료 시간과 exact digest를 확인한 뒤 승인용 Prod PR만 생성합니다.

```text
schemaVersion, environment, region, sourceSha, workflow, image,
attestation, gitops, cluster, slo, issuedAt, expiresAt
```

root key를 평탄화하거나 이름을 바꾼 evidence는 호환 대상으로 처리하지 않습니다.

| 파일 | 실행 시점 | 결과 |
| --- | --- | --- |
| `.github/workflows/test.yml` | application PR | lint, unit test, PostgreSQL transaction test, image build |
| `.github/workflows/ci.yml` | `main` push | ECR push, Dev app·migration digest PR, validation 후 auto-merge |
| `.github/workflows/promote.yml` | 수동 dispatch | 현재 Dev app·migration digest를 Prod에 복사한 승인 PR |

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
