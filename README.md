# Mini Commerce

PostgreSQL의 상품·재고·주문을 처리하는 Node.js 24.2+ / Express 5 서비스입니다. 주문 생성은
하나의 DB transaction에서 멱등성 확인, 재고 잠금, 주문 저장과 재고 차감을 수행합니다.
컨테이너 배포와 DB migration은 같은 immutable image digest를 사용합니다.

**운영 범위:** 이 코드는 신뢰된 내부 호출자를 위한 commerce API입니다. 고객 인증, 주문 소유자 확인,
결제, 개인정보 처리, tenant 분리는 구현하지 않았습니다. 인터넷 고객에게 직접 노출하는 상용
쇼핑몰로 사용할 수는 없으며, 해당 요구는 [아키텍처의 경계](docs/architecture.md#신뢰-경계와-미구현-기능)에서 먼저 확인해야 합니다.

## 목차

- [구조와 책임](#구조와-책임)
- [로컬 실행과 검증](#로컬-실행과-검증)
- [런타임 설정](#런타임-설정)
- [GitHub 전달 설정](#github-전달-설정)
- [DB 변경과 운영 도구](#db-변경과-운영-도구)
- [검증 범위](#검증-범위)

## 구조와 책임

애플리케이션 코드와 전달 자동화만 이 저장소가 소유합니다. 클러스터/IAM/RDS는 `EKS-infra`,
Helm/Argo CD/롤아웃 정책과 배포 증빙은 `argocd-gitops`의 책임입니다.
구체적인 함수, transaction 순서, 공급망 검증과 발표용 다이어그램은 [아키텍처](docs/architecture.md)에 있습니다.

| 경로 | 소유하는 동작 |
| --- | --- |
| `src/` | HTTP API, 주문 규칙, PostgreSQL repository, readiness·종료, metrics·trace·log |
| `migrations/` | 적용 후 바이트를 바꾸지 않는 forward-only schema 변경 |
| `openapi/` | 공개 business API 계약과 backward compatibility 기준 |
| `scripts/` | migration, 공급망·승격 증빙, 이미지/GitOps 값 검증, 복구·불변식 검사 |
| `test/unit/` | 서비스 함수·HTTP·설정·readiness |
| `test/integration/` | 실제 PostgreSQL·transaction·migration·telemetry |
| `test/delivery/` | 이미지·GitOps values·공급망·OpenAPI 호환성 |
| `load/` | 명시적으로 선택한 Dev host의 제한된 k6 부하 |
| `.github/workflows/` | PR 검증, main 이미지 발행·Dev 전달, 별도 Prod 승격 |
| `docs/` | 지속적으로 관리하는 서비스 아키텍처 |
| `Dockerfile`, `compose.yaml` | 비 root 실행 이미지, localhost에만 노출하는 개발용 PostgreSQL |

검증은 Node 기본 runner로 실행합니다. 파일 표현만 고정하던 검사와 별도 Shell 테스트 실행기는 제공하지 않습니다.

## 로컬 실행과 검증

기본 개발 모드는 DB를 사용하지 않으므로 listener와 telemetry만 점검할 수 있습니다.
`/readyz`가 성공해도 DB가 꺼져 있으면 business API는 503을 반환합니다. 실제 주문 기능은 DB가 필요합니다.

```bash
npm ci --ignore-scripts
npm run lint
npm test
```

`npm test`는 `DATABASE_TEST_URL`이 없으면 PostgreSQL integration test를 SKIP합니다.
CI는 `npm run test:ci`를 사용하며, 해당 URL이 없거나 형식이 잘못되면 테스트 시작 전에 실패합니다.
이 테스트들은 테이블을 초기화하고 임시 DB를 생성하므로 **폐기 가능한 테스트 DB에만 연결**해야 합니다.

로컬 PostgreSQL을 사용할 때:

```bash
export APP_ENV=development OTEL_TRACES_EXPORTER=none
export DB_PASSWORD="$(openssl rand -hex 24)"
docker compose up -d --wait postgres
export DATABASE_ENABLED=true DB_SSL=false
export DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=commerce DB_USER=commerce
npm run migrate:up -- --target 002_expand_product_display_name
npm start
```

다른 터미널에서 확인합니다.

```bash
curl -fsS http://127.0.0.1:3001/readyz
curl -fsS http://127.0.0.1:3000/products
curl -fsS -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: order-001' \
  -d '{"items":[{"productId":1,"quantity":2}]}'
```

같은 키와 같은 정규화된 상품·수량 조합은 저장된 주문을 반환합니다. 같은 키에 다른 주문은
`409`로 거부합니다. 이 규칙은 외부 재시도가 중복 차감이나 잘못된 주문 성공으로 처리되는 것을 막습니다.
종료는 `docker compose down`으로 수행하며 volume을 삭제하지 않으면 개발 DB 데이터는 유지됩니다.

## 런타임 설정

production은 DB 활성화와 인증서를 검증하는 TLS를 강제합니다. 시작 시 현재 이미지에 필요한
schema가 조회 가능한지 확인하고, 실패하면 listener와 pool을 정리하고 종료해 supervisor가 재시도하도록 합니다.

| 설정 | 기본 / 운영 기준 |
| --- | --- |
| `APP_ENV` | `NODE_ENV` 값을 따르고, 둘 다 없으면 `development`; 운영은 `production` 명시 |
| `PORT`, `MANAGEMENT_PORT` | `3000`, `3001`; 서로 다른 값. 관리 포트는 외부 접근 차단 |
| `DATABASE_ENABLED` | 개발 기본 `false`; production에서는 `true` 필수 |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | DB 활성화 시 모두 필수; runtime 전용 최소 권한 계정 |
| `DB_PORT`, `DB_SSL` | `5432`, 개발 기본 `false`; production TLS `true` 필수 |
| `NODE_EXTRA_CA_CERTS` | 사설/RDS CA가 기본 trust store에 없으면 읽기 전용 PEM 파일 경로 |
| `DB_POOL_MAX` | Pod당 `10`, 허용 `1..100`; replica·surge·다른 DB 사용자의 총연결 예산과 함께 결정 |
| `DB_CONNECTION_TIMEOUT_MS` | pool 연결 대기 `2000` ms |
| `DB_LOCK_TIMEOUT_MS` | DB 서버 잠금 대기 `1000` ms |
| `DB_STATEMENT_TIMEOUT_MS` | DB 서버 statement 실행 `2000` ms |
| `DB_QUERY_TIMEOUT_MS` | client 응답 대기 `3000` ms; 서버 제한보다 여유 있게 설정 |
| `DB_IDLE_TRANSACTION_TIMEOUT_MS` | 열린 transaction의 유휴 session `10000` ms |
| `READINESS_DEPENDENCY_POLICY` | `startup-only`; `continuous`는 development/test 전용 |
| `SHUTDOWN_DEADLINE_MS` | `30000` ms; Kubernetes 종료 유예시간은 이보다 길게 설정 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP trace URL (`/v1/traces` 포함); 로컬 비활성화는 `OTEL_TRACES_EXPORTER=none` |
| `APP_VERSION`, `GIT_SHA`, `BUILD_DATE` | 이미지 build metadata. 관리 포트 `/version`에서 확인 |

production의 startup-only readiness는 초기 schema 확인 후 DB 장애만으로 모든 Pod를 동시에
트래픽 대상에서 제거하지 않습니다. 대신 business 요청은 503으로 실패하고 DB 실패·pool 대기 metric을
기록합니다. `/healthz`는 process 확인이며 DB 건전성 지표가 아닙니다.

## GitHub 전달 설정

`delivery-preflight`는 AWS credential 발급·빌드 전에 registry 변수의 누락과 형식을 검증합니다.
GitOps job은 보호된 environment 안에서 App 설정과 RSA private key를 검증합니다.
검증 오류에는 필드 이름만 기록하며 기본 Region·계정·secret을 임의로 채우지 않습니다.

| Repository variable | 운영자가 확인할 원천 |
| --- | --- |
| `AWS_REGION` | 실제 배포 Region. 현재 증빙 schema는 `us-east-1`, `ap-northeast-2` 지원 |
| `AWS_ROLE_ARN` | EKS-infra registry root의 `image_push_role_arn` 출력 |
| `AWS_ATTEST_VERIFY_ROLE_ARN` | `attest_verify_role_arn` 출력; OCI attestation 쓰기와 검증 권한 |
| `ECR_REPOSITORY` | `image_repository_name` 출력; registry URL이 아닌 repository 이름 |
| `GITOPS_APP_ID` | 설치한 GitHub App ID; 필요하면 environment별 override |
| `GITOPS_OWNER`, `GITOPS_REPOSITORY_NAME` | 실제 GitOps 저장소 식별자 |

`GITOPS_APP_PRIVATE_KEY`는 `gitops-dev-delivery`와 `gitops-production` environment secret에 각각
설정합니다. 두 environment의 deployment branch는 `main`으로 제한합니다. Dev 자동 전달에는
승인자를 두지 않을 수 있지만 Prod에는 조직 정책과 지원되는 protection rule에 맞는 required reviewer를 둡니다.

GitHub App은 GitOps 저장소에만 설치하고 Contents / Pull requests read-write를 부여합니다.
Ruleset bypass actor로 등록하지 않으며, Prod PR은 자동 merge하지 않습니다. Dev/Prod credential 자체를
격리해야 하면 별도 App ID/private key를 사용합니다. **코드 검사로 실제 GitHub 설정을 증명할 수 없습니다.**

PR와 main은 실제 PostgreSQL 테스트, ESLint, runtime dependency `npm audit`를 수행합니다.
PR의 `dependency-review` job은 lock 파일 기준 전체 production dependency graph를
`npm audit --omit=dev --audit-level=high`로 검사합니다. High/Critical 취약점이나 검사 오류는
job을 실패시킵니다. GitHub Dependency Review API의 403 오류를 해결하기 위해 npm 검사로 전환했으며,
기존 required check 이름은 유지합니다. GitHub의 변경분 dependency review와는 검사 범위가 다릅니다.
Required check를 특정 path 변경에만 실행되는 dependency-review에 단독 의존하지 마세요. 모든 PR에서 실행하는
`test` job도 보호 규칙에 포함하고, 실제 조직/저장소 Ruleset에서 병합 차단 여부를 확인해야 합니다.

main CI는 AMD64/ARM64 이미지를 한 번 발행하고 각 child manifest를 scan합니다. provenance·SBOM attestation과 OCI referrer를 확인한 뒤 Dev digest PR을 생성합니다. Argo CD가 GitOps main 변경을 감지해 Dev를 자동 sync합니다.

Prod는 `promote-dev-digest-to-prod` workflow에 `ci_run_id`, `ci_run_attempt`와 선택적 `expected_digest`를 입력합니다. 성공한 main CI의 정확한 실행 결과와 Dev digest가 일치해야 승인 PR을 생성합니다. `gitops-production` 승인자는 Dev 상태·트래픽·관측 지표를 확인해야 합니다. Prod PR은 자동 merge하지 않으며, merge 후 Argo CD 수동 sync로 canary를 시작합니다.

별도 DEV_READY 조립·증빙 게시·baseline JSON 단계는 없습니다. 실행 기록은 CI run, GitOps PR/SHA, Argo revision과 관측 결과로 추적합니다.

## DB 변경과 운영 도구

`migrate:up`은 대상 migration을 반드시 명시해야 합니다. API process가 시작하면서 migration을 수행하지 않습니다.
적용된 001–003 파일과 checksum ledger를 보존하고, 변경이 필요하면 새 migration으로 진행합니다.

- `001_initial_commerce`: 테이블·FK·check constraint와 초기 4개 catalog/재고 seed. 실제 상품 전환은 승인된 데이터 작업으로 처리합니다.
- `002_expand_product_display_name`: `name` 보존, `display_name` 추가/backfill. 현재 runtime의 `v2prime`은 `display_name`을 읽습니다.
- `003_contract_product_name`: retained rollback candidate가 모두 `v2prime`인지 증명한 뒤 legacy `name` 제거.
  운영자가 `ROLLBACK_CANDIDATES_FILE`과 기대 cluster/revision/region을 주입해야 합니다.

`src/migration-ledger.js`는 파일 checksum, migration 직렬화, contract 증빙 hash를 검증합니다.
Migration Job에는 별도의 DDL 계정을 사용하고, DB lock/statement 제한은 대상 테이블 크기와 승인된
유지보수 시간에 맞게 검토합니다. runtime의 짧은 query timeout을 대규모 migration 시간 예산으로 오해하지 마세요.

| 도구 | 사용하는 시점 |
| --- | --- |
| `scripts/verify-commerce-invariants.mjs` | 부하/복구 후 주문·FK·idempotency·재고 불변식 검증 |
| `scripts/verify-restore.mjs` | `verifyRestore` 함수로 독립 recovery DB의 schema·row checksum을 원본과 비교 |
| `scripts/verify-image-index.sh` | 정확한 digest의 AMD64/ARM64 index 확인 |
| `scripts/verify-supply-chain.mjs` | scan·attestation·OCI referrer·immutable repository identity 확인 |
| `scripts/gitops-values.mjs` | Dev/Prod app·migration digest 변경, rollback에서는 app만 변경 |
| `scripts/wait-pr-terminal-state.sh` | Dev 자동 전달 PR의 merge/close 종료 대기 |
| `load/k6-baseline.js`, `load/k6-stateful.js` | 허용한 Dev HTTPS host에 제한된 읽기/주문 부하 |

이 도구들은 일부 실제 DB 쓰기·부하를 수행합니다. 운영 대상, 권한, 변경 승인과
복구 계획을 먼저 확인해야 하며, fixture 테스트 통과를 실제 실행 증거로 사용하지 않습니다.

## 검증 범위

핵심 요약: 일반 테스트와 실제 DB 테스트를 구분합니다. 원격 CI/이미지 빌드/클러스터 검증은 해당 실행 결과로 확인합니다.

```bash
npm run lint
npm test
```

폐기 가능한 PostgreSQL URL을 `DATABASE_TEST_URL`에 설정한 뒤 `npm run test:ci`를 실행하면 CI와 같은 필수 DB 검사를 수행합니다. URL이 없으면 `npm test`의 DB 검사는 SKIP이고, `test:ci`는 실패합니다. `npm run test:postgres`는 integration 그룹만 실행합니다.

이미지 빌드는 `docker build --tag mini-commerce:test .`로 확인합니다. CI 성공, 실제 EKS 배포, 사용자 요청과 관측 지표 확인은 각각 별도의 결과입니다.
