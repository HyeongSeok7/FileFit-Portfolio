# 파일핏

제출할 사진·PDF를 브라우저에서 점검하고 변환하는 웹입니다. 회원가입 없이도 모든 파일 도구를 쓸 수 있습니다. 계정으로 로그인하면 **제출 기준만** PostgreSQL에 저장하고 읽기 전용 링크로 공유할 수 있습니다. 원본 파일과 변환 파일은 API로 전송하지 않습니다.

## 기능

- 한국어 제출 안내 문구에서 형식, 파일당 최소·최대 용량, 전체 용량, 개수, PDF 페이지, 사진 크기를 초안으로 추출하고 직접 수정
- 실제 파일 형식·용량·이미지 크기·PDF 페이지를 기준으로 제출 조건 점검
- 사진 크기·비율·형식 변경, JPG/WebP 목표 용량 탐색
- PDF 합치기·페이지 추출·회전·사진↔PDF·스캔 PDF 압축
- 계정 등록·로그인·로그아웃, 제출 기준 저장·검색·수정·삭제, 읽기 전용 링크 공유·중지
- 작업 실패 시 화면 안에 원인과 다음 조치 표시. 파일 도구는 API 장애가 있어도 사용 가능

## 구조

| 구성 | 경로 | 역할 |
| --- | --- | --- |
| 프런트엔드 | `/` | React·Vite 정적 사이트. 파일 검사·변환을 브라우저에서 수행 |
| API | `/api` | NestJS. 계정, 로그인 세션, 제출 기준 CRUD·공유 |
| DB | PostgreSQL | 사용자, 암호 해시, 세션 토큰 해시, 제출 기준 JSON 저장 |

API는 파일 업로드 경로를 제공하지 않습니다. 제출 기준은 `formats`, `minEachBytes`, `maxEachBytes`, `maxTotalBytes`, `maxFiles`, `maxPages`, `width`, `height`로 저장합니다. 로그인 토큰은 브라우저 `sessionStorage`에 보관되어 탭 세션이 끝나면 사라지고, 서버에는 SHA-256 해시만 남습니다. 비밀번호는 고유 salt로 scrypt 해시합니다. 공유 링크를 가진 사람은 조건만 읽을 수 있으며 소유자가 공유를 중지하면 즉시 접근할 수 없습니다.

## 로컬 실행

Node 24와 PostgreSQL이 필요합니다. 데이터베이스와 사용자 `filefit`을 만들고 다음 명령을 각 터미널에서 실행하세요.

```powershell
cd api
npm ci
$env:DATABASE_URL='postgresql://filefit:password@127.0.0.1:5432/filefit'
$env:FRONTEND_ORIGIN='http://127.0.0.1:5173'
npm run migrate
npm run build
npm run start:prod
```

```powershell
npm ci
$env:VITE_API_BASE_URL='http://127.0.0.1:3001'
npm run dev
```

브라우저에서 `http://127.0.0.1:5173`에 접속합니다. API 없이 파일 기능만 확인하려면 `VITE_API_BASE_URL`을 설정하지 않고 프런트엔드만 실행하세요. 프런트엔드 빌드는 `npm run build`, API 빌드는 `cd api; npm run build`입니다. API가 실행 중이고 테스트 DB를 사용할 수 있을 때 `cd api; npm run test:smoke`로 회원·저장·권한·충돌·공유 흐름을 검증할 수 있습니다. 테스트는 임의의 사용자와 조건을 DB에 생성합니다.

## Render 배포

루트의 `render.yaml`은 새 공개 주소용 정적 사이트 `filefit-pf`, 기존 링크 유지용 정적 사이트 `filefit`, 싱가포르 리전의 Node 웹 서비스 `filefit-api`를 정의합니다. PostgreSQL은 Neon 같은 **외부 서비스**에서 먼저 생성합니다. Render 무료 PostgreSQL은 30일 후 만료되므로 이 Blueprint에는 포함하지 않았습니다. 소스를 GitHub/GitLab 저장소 최상위에 올리고 Render **New → Blueprint**에서 연결하세요.

Neon에서 프로젝트를 생성하고 Render API와 가까운 `AWS Asia Pacific (Singapore)` 리전이 제공된다면 선택하세요. **Connection Details**에서 `Direct connection`의 PostgreSQL URL을 복사합니다. 연결 문자열 전체에 비밀번호가 포함되므로 공개 저장소나 프런트엔드 코드에 넣지 마세요. Neon이 제공하는 TLS 설정(`sslmode=require` 등)이 포함된 URL을 그대로 사용합니다.

Blueprint를 처음 배포할 때 `DATABASE_URL`을 입력합니다. 두 사이트의 API 주소와 API의 허용 사이트 주소는 Blueprint가 각 서비스의 실제 Render URL로 자동 연결합니다.

| 서비스 | 변수 | 예시 |
| --- | --- | --- |
| `filefit-api` | `DATABASE_URL` | Neon의 **Direct connection** URL 전체. 비밀값이므로 Render 환경 변수에만 입력 |
| `filefit-pf`, `filefit` | `VITE_API_BASE_URL` | `filefit-api`의 실제 공개 주소를 자동 참조 |
| `filefit-api` | `FRONTEND_ORIGIN` | `filefit-pf`의 실제 공개 주소를 자동 참조 |
| `filefit-api` | `LEGACY_FRONTEND_ORIGIN` | 기존 `filefit`의 실제 공개 주소를 자동 참조 |

새 주소가 원하는 이름으로 생성됐는지 Render 대시보드에서 확인하세요. `VITE_API_BASE_URL`은 Vite 빌드 시 정적 파일에 포함되므로 값을 직접 바꿀 때는 Render에서 **Save, rebuild, and deploy**를 선택해야 합니다. API는 시작할 때 누락된 SQL 마이그레이션을 적용합니다. `/api/health`가 `{ "ok": true }`를 반환하는지 확인하고, 사이트에서 회원가입→조건 저장→공유→다른 브라우저에서 링크 열기 순서로 점검하세요. Render의 상시 상태 확인은 DB를 깨우지 않는 `/api/live`를 사용합니다.

Blueprint의 `DATABASE_URL`은 `sync: false`라서 초기 생성 시에만 Render가 값을 묻습니다. 이후 연결 문자열을 바꾸려면 API 서비스의 **Environment**에서 직접 수정하세요. 무료 API는 비활성 시 잠들기 때문에 첫 요청이 느릴 수 있습니다. 외부 DB도 무료 플랜 한도와 백업 정책을 확인하고, 중요한 조건 데이터라면 별도로 백업하세요. [Render Blueprint 변수 안내](https://render.com/docs/blueprint-spec), [Render 무료 플랜 안내](https://render.com/docs/free)

## API

모든 오류 응답은 `{ "code": "...", "message": "...", "retryable": false }` 형식입니다. 인증이 필요한 요청은 `Authorization: Bearer <token>`을 보냅니다.

| 메서드·경로 | 설명 |
| --- | --- |
| `GET /api/live` | 서버 프로세스 상태(DB 요청 없음) |
| `GET /api/health` | API·DB 상태 |
| `POST /api/auth/register`, `POST /api/auth/login` | `{username,password}` → `{token,user}` |
| `GET /api/auth/me`, `POST /api/auth/logout` | 세션 확인·폐기 |
| `GET /api/rule-sets?q=&page=&limit=` | 내 조건 검색·페이지 조회 |
| `POST /api/rule-sets` | `{title,rules}` 저장 |
| `GET /api/rule-sets/:id` | 내 조건 조회 |
| `PATCH /api/rule-sets/:id` | `{title?,rules?,expectedVersion}` 수정. 버전 충돌은 409 |
| `DELETE /api/rule-sets/:id` | 내 조건 삭제 |
| `POST/DELETE /api/rule-sets/:id/share` | 공유 링크 발급·중지 |
| `GET /api/shared/:shareId` | 공개된 조건 읽기 전용 조회 |

## 품질·제한

사진은 최대 80MB, PDF는 최대 100MB, 한 번에 최대 50개까지 추가할 수 있습니다. 브라우저 메모리·기기 성능에 따라 처리 시간이 초과될 수 있습니다. 사진을 확대해도 원본에 없는 디테일은 복원할 수 없습니다. 스캔 PDF 압축은 페이지를 이미지로 다시 만들어 검색 가능한 텍스트·링크를 잃을 수 있습니다. 제출처의 안내와 최종 업로드 결과를 반드시 확인하세요.

인증 요청은 API 인스턴스별 메모리에서 15분 단위로 제한합니다. 여러 API 인스턴스로 확장할 때는 공용 저장소 기반 제한이 필요합니다. 계정 복구와 이메일 인증은 현재 제공하지 않으므로 실제 대규모 서비스 전에는 추가해야 합니다.
