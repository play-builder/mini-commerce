# Mini Commerce production readiness 검토 기록

검토 기준은 `origin/main`의 `8e2aa475`이며 작업 브랜치는 `playbuilder/production-readiness`입니다.
2026-09-08 검토에서 확인한 결함을 수정하고 로컬 검증을 수행했습니다. 이 문서의 결과는
해당 worktree의 수정 코드에 대한 결과이며, 과거 main CI 성공을 재사용하지 않습니다.

## 수정한 운영 결함

원인·수정·회귀 검증을 함께 기록합니다. 모든 변경은 앱 저장소에 한정하고
기존 migration 바이트, lock 파일의 의존성 버전, 다른 저장소가 소비하는 evidence schema를 보존했습니다.

| 문제 | 수정 | 주요 검증 |
| --- | --- | --- |
| `AWS_REGION` 등 누락이 뒤늦게 AWS action에서 실패 | read-only registry preflight가 credential·build 전에 필드명으로 실패 | workflow의 실제 preflight command를 변수 누락으로 실행 |
| GitOps secret/변수가 잘못돼도 token 발급 시도 | environment 내 RSA key·App/repository 형식 검사 | valid RSA, 잘못된 key, 값 미출력 검사 |
| ARM64 build가 runner의 암묵적 emulation에 의존 | Buildx 전 QEMU 단계, Action SHA와 binfmt index digest 고정 | 단계 순서·lock 일치; registry digest 읽기 확인 |
| image 생성 시각이 repository 수정 시각 | build job의 실제 UTC 시각을 `BUILD_DATE`에 기록 | workflow 구성 검토 |
| CI에서 DB env 누락 시 integration test가 SKIP 가능 | `test:ci`는 DB URL 없으면 시작 전 실패 | 별도 subprocess의 실패 exit 및 안전한 오류 메시지 |
| 일반 PR에 runtime vulnerability gate 부족 | PR/main `npm audit --omit=dev --audit-level=high` | 공식 npm audit endpoint 조회 성공, 0 vulnerabilities |
| `.mjs` 운영 도구가 lint 대상 아님 | `.js`와 `.mjs` 모두 ESLint | 전체 lint 성공 |
| local secret 파일이 build context에 포함 가능 | `.env*`, `.npmrc`, PEM/key 제외, install lifecycle script 비활성화 | ignore/Dockerfile 검토 및 ignore-scripts 설치·tests |
| production에서 DB 없이 ready 가능 | DB 활성화·TLS 강제, `NODE_ENV` fallback 적용 | production·NODE_ENV-only config 거부 |
| DB 접속만 되고 schema가 없어도 ready | 현재 schema query가 성공해야 listener 기동 | 초기 실패·pool 정리 테스트; 실제 PG schema 부재·기동 실패 테스트 통과 |
| startup listener bind 실패가 정리되지 않음 | listener를 기다리고 실패 시 모든 생성 자원 정리 | 실제 임시 포트 충돌 회귀 |
| 잘못된 JSON이 입력 내용을 오류로 반사 가능 | parser 오류별 고정 메시지; request ID는 유지 | 실제 HTTP 400/413·body 미반사 |
| management 오류에 raw stack 노출 가능 | 고정된 500 JSON error handler | `/metrics` 예외를 실제 HTTP로 재현 |
| 같은 key에 다른 주문도 기존 주문 성공으로 반환 | 정규화한 상품·수량 비교 후 409 | 동일 요청 replay·다른 요청 conflict·추가 stock lock 없음 |
| 입력의 boolean/string 변환·중복 수량 한도 우회 | JSON 숫자·합산 수량·item 수·int32 금액 확인 | coercion/aggregate/overflow negative tests |
| client timeout만 있어 서버 SQL·lock이 지속 가능 | runtime server statement/lock/idle transaction 제한 | pool 옵션 확인; 실제 PostgreSQL SQLSTATE 취소 검사 통과 |
| ROLLBACK 실패 연결을 pool에 반환 | 불확실한 connection 폐기 | 원래 오류 보존·release(discard) 확인 |
| migration ledger가 runtime의 짧은 timeout에 영향 | ledger transaction은 별도 DDL runner의 수명을 유지 | 적용된 migration은 변경하지 않음; 실제 장기 migration 미실행 |
| restore helper의 pool 객체만 다르면 동일 DB도 비교 성공 | 실제 DB endpoint identity 비교, read-only repeatable-read snapshot | 동일 DB 거부·정리/rollback·결과 schema 보존; 실제 PostgreSQL 복구·동일 DB 거부 검사 통과 |

Network ECR과 Dev·Prod EKS 계정의 동일성을 잘못 요구하던 DEV_READY/Prod baseline 검사를 수정했습니다. 각 계정의 canonical identity는 보존하고, image repository·digest·region·실행 증빙 결속은 그대로 확인합니다. 현재 producer v2를 EKS/GitOps 소비자와 교차 검증하며 immutable repository ID도 확인합니다.

## 정리한 코드와 문서

언어 또는 파일 수를 줄이기 위한 삭제는 하지 않았습니다. 사용되지 않는 설정과 문구 검사만
제거하고, transaction·동시성·migration·rollback·공급망 테스트는 유지했습니다.

- `src/config.js`의 미사용 반환값 `port` alias, `nodeName`, `otelEndpoint`, `otelResourceAttributes`, `secretKeys` 제거.
  `PORT`·OTEL 환경변수 자체의 동작은 유지하며 실제 consumer가 직접 읽는 경로는 보존했습니다.
- `test/workflow-contract.test.js`의 README 특정 문장 일치 테스트 제거. 실제 environment/permission 검사는 유지.
- `README.md`를 운영 시작점으로 다시 작성하고, 과거 교육용 release/fault 재현 설명과 외부 교육 경로를 제거.
- `docs/architecture.md`에 runtime·transaction·delivery Mermaid, 폴더/함수 map, startup/enterprise 선택과 신뢰 경계 추가.
- `migrations/001–003`, v1/v2/v2prime compatibility 경로, rollback·supply-chain fixture는 운영 호환성 때문에 유지.
- 새 runtime framework, 고객 identity 정책, 결제 기능, cloud resource, GitHub 설정은 추가하지 않음.

## 이번 코드의 검증 결과

로컬 Node는 `v24.16.0`, npm은 `11.13.0`입니다. CI/image pin은 `24.20.0`을 유지하므로
정확히 같은 Node patch와 실제 container 검증은 CI에서 별도로 수행해야 합니다.

| 검사 | 결과 / 범위 |
| --- | --- |
| `npm ci --ignore-scripts` | 성공, 257 packages 설치; lock 파일 변경 없음 |
| `npm run lint` | 성공; `.mjs` 포함 |
| `DATABASE_TEST_URL=... npm run test:ci` | **166 tests, 166 PASS, SKIP 0, FAIL 0**; 임시 PostgreSQL 17.6, 41.8초 |
| `bash test/curl-loop.test.sh` | 성공, `curl-loop test passed`; 로컬 HTTP 통합 |
| OpenAPI backward compatibility (`origin/main`) | 성공; 기존 operation·response schema 보존 |
| Shell syntax / `git diff --check` | 성공 |
| `npm audit --omit=dev --audit-level=high` | 성공, 0 vulnerabilities; 조회 시점의 production dependency graph |
| QEMU/builder 설치 | 미실행; 공개 binfmt index digest만 daemon 없이 원격 조회 |
| 실제 PostgreSQL 통합 검증 | PASS; 체크섬을 검증한 임시 PostgreSQL 17.6, localhost 전용 데이터 디렉터리 |
| Docker image build·ARM64 실행 | 미실행; 사용자 Docker를 시작하지 않음 |
| GitHub Actions·OIDC·ECR·GitOps PR·cloud rollout | 미실행; GitHub 설정 변경·실행 없음; 로컬 commit은 최종 전달 기록 참조 |

처음 sandbox 안에서 실행한 HTTP 테스트는 `listen EPERM`으로 실패했습니다. 동일 코드를
localhost listen이 허용된 환경에서 다시 실행한 결과만 최종 테스트 수치로 사용합니다.
PostgreSQL 취소/schema/restore/동시성/계측 검사를 모두 실행했습니다. Span export가 비동기로 완료되는 실제 SDK 동작에 맞춰 검사는 `forceFlush()` 후 수집 결과를 판단합니다. RDS·TLS·EKS 환경의 실행 결과를 대신하지는 않습니다.

## 배포 전 남은 조건과 변경 영향

여기까지는 운영 안전장치를 갖추기 위한 코드 준비입니다. 실제 배포 승인과 고객 노출 승인은
외부 설정·runtime 증거가 충족돼야 합니다.

1. 실제 Terraform 출력에 맞춰 `AWS_REGION`, Role ARN, ECR name, App/environment secret 설정.
   preflight는 형식 검사이며 IAM trust·App installation·Ruleset 권한의 성공 증거가 아닙니다.
2. PR에서도 이번 SHA의 PostgreSQL **전체 통과·SKIP 0**, Docker build, required checks를 확인.
   main에서 두 architecture build/scan·attestation·Dev 전달이 실제로 실행돼야 합니다.
3. workload의 `APP_ENV=production`, `DATABASE_ENABLED=true`, `DB_SSL=true`, CA trust와 migration002 이상 schema 확인.
   DB 비활성화로 process만 띄우던 container smoke는 `APP_ENV=test`를 명시해야 합니다.
4. 초기 DB/schema 실패는 계속 not-ready로 살아 있는 대신 실패 exit 후 supervisor가 재시도합니다.
   probe/restart 정책과 rollout timeout, runtime pool 총연결 수와 query/lock 시간 예산을 확인해야 합니다.
5. 같은 key의 다른 주문은 409, 비정상 숫자 타입/과도한 요청은 400입니다. 기존 client가 타입 coercion이나
   key 재사용에 의존했다면 client를 수정해야 합니다. 응답 형태·evidence key는 변경하지 않았습니다.
6. 인증·주문 owner·tenant·결제가 없으므로 현재 service는 신뢰된 내부 caller만 접근하게 해야 합니다.
   고객 API로 직접 사용할 경우 해당 기능을 별도 제품 요구로 구현하고 검증하기 전까지 노출 승인 불가.
7. management 포트·DB endpoint 접근 제한, DML/DDL 계정 분리, secret rotation, RDS 복구 drill은 별도 실측 필요.
8. restore helper는 두 endpoint의 snapshot 비교입니다. 원본 쓰기 정지/공통 복구 시점과 백업 원본 provenance를
   증명하지 않으며 전체 데이터를 메모리에 읽으므로 큰 DB에는 별도 검증 전략이 필요합니다.

롤백은 기존 검증된 application image digest로 수행하고 migration image와 applied ledger를 보존합니다.
이 변경에는 DDL 변경이 없습니다. 다만 이전 이미지로 되돌리면 이번 입력·오류·DB 안전장치도 함께 사라집니다.

## 공식 근거

외부 기능은 공식 문서와 실제 읽기 전용 조회를 함께 확인했습니다. 로컬 코드 검증이 외부 서비스의
현재 설정을 대신하지는 않습니다.

- [node-postgres client timeout](https://node-postgres.com/apis/client): client timeout과 서버 SQL 제한 구분.
- [Express body-parser errors](https://expressjs.com/en/resources/middleware/body-parser/): payload parser 오류 구조.
- [Docker build context](https://docs.docker.com/build/concepts/context/): `.dockerignore` 전송 경계.
- [Docker multi-platform CI](https://docs.docker.com/build/ci/github-actions/multi-platform/): QEMU → Buildx 흐름.
- [QEMU action v4.3.0](https://github.com/docker/setup-qemu-action/releases/tag/v4.3.0): 고정한 Action release.
- [AWS ECR ListImageReferrers](https://docs.aws.amazon.com/cli/latest/reference/ecr/list-image-referrers.html): 실제 CLI 명령/필드 확인.
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/): production graph의 취약점 검사 범위.
