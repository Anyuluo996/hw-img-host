# AGENTS.md

## Package manager & engine

- **pnpm only**: package manager pinned to `pnpm@11.0.9` in `package.json`. `pnpm install` to install.
- **Node**: `^20.19.0 || >=22.12.0`

## Commands

| Command           | What it does                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`        | Dev server on `localhost:5173` (Vite HMR)                                                                             |
| `pnpm build`      | Runs `type-check` + `build-only` in parallel via `run-p`. Pass extra args to build via `pnpm build -- --mode staging` |
| `pnpm type-check` | `vue-tsc --build` (type-checks all tsconfig references)                                                               |
| `pnpm lint`       | `eslint . --fix` (flat config in `eslint.config.ts`)                                                                  |
| `pnpm format`     | `prettier --write src/` (src/ only)                                                                                   |
| `pnpm preview`    | Preview the production build locally                                                                                  |

## Build tooling quirks

- **Tailwind CSS v4** via `@tailwindcss/vite` Vite plugin (no PostCSS config or `tailwind.config.ts`). The import is in `src/assets/main.css` as `@import 'tailwindcss'`.
- **UI components**: shadcn-vue (`components.json`), style `new-york`, base `neutral`, with CSS variables in `src/assets/main.css`. Use `@/lib/utils` for the `cn()` helper. Add components via `npx shadcn-vue@latest add <name>`.

## Architecture

```
Browser (Vue 3 SPA)
  ├─ Password login → POST /api/auth/login
  │    └─ returns JWT token (7d expiry, stored in localStorage)
  ├─ Server-side upload → POST /api/upload/img (multipart/form-data, multer 20MB)
  │    └─ auto-detects type by extension:
  │         ├─ image (png/jpg/webp/...) → CNB imgs endpoint (TOKEN_IMG) → /img-api/* proxy
  │         └─ other (pdf/zip/...)      → CNB files endpoint (TOKEN_FILE) → /file-api/* proxy
  │    └─ returns proxy URLs + assets.path (path needed for later deletion)
  ├─ File index → /kv-api (EdgeOne KV, edge function)
  │    └─ each record stored as its own key `img_{id}` (list via prefix scan)
  │    └─ supports tags: string[] for categorization
  │    └─ methods: GET (list) / POST (add) / PUT /{id} (update tags) / DELETE /{id} (remove)
  └─ Delete file → DELETE /kv-api/{id} (remove index) + DELETE /api/delete { path } (remove CNB file)

Image/file serving:
  GET /img-api/*  → edge-functions/img-api/[[path]].ts  → proxies CNB -/imgs/ (images, inline)
  GET /file-api/* → edge-functions/file-api/[[path]].ts → proxies CNB -/files/ (force download)
  GET /img?tag=   → edge-functions/img/index.ts → random image 302 redirect (public, no auth; ?tag=a,b OR-match)
```

- **Frontend**: Vue 3 + `<script setup lang="ts">` + Composition API. Three routes: `/` (HomeView), `/gallery` (GalleryView), `/login` (LoginView). Auth via `useAuth` composable (`src/composables/useAuth.ts`) — JWT stored in localStorage, axios interceptor adds Bearer token to all requests. Login redirect is handled by router guard in `src/router/index.ts`.
- **Backend API**: `node-functions/api/[[default]].ts` mounts Express sub-routers:
  - `routes/auth.ts` — `POST /api/auth/login` (validates `UPLOAD_PASSWORD`, returns JWT)
  - `routes/upload.ts` — `GET /api/upload/sign` + `POST /api/upload/img` (auto-routes imgs/files by extension)
  - `routes/delete.ts` — `DELETE /api/delete` (single) + `POST /api/delete/batch` (batch); calls CNB DELETE API (TOKEN_DELETE, `repo-manage:rw`)
  - `_auth.ts` — JWT sign/verify using `UPLOAD_PASSWORD` as secret; `authMiddleware` for route protection
  - `_utils.ts` — `uploadToCnb()`, `signUpload()`, `deleteFromCnb()`, `buildAccessUrl()`, `extractImagePath()`, `detectUploadType()`
  - `_reply.ts` — `reply()` helper, shape: `{ code, msg, data }` (code=0 is success)
- **Edge proxy**: `edge-functions/img-api/` and `edge-functions/file-api/` catch `/img-api/*` and `/file-api/*`, forward to CNB with CORS headers.
- **Edge KV index**: `edge-functions/kv-api/[[path]].ts` — GET (list via prefix scan) / POST (add) / DELETE (remove). Each record in its own KV key `img_{id}`; auto-migrates legacy single-array `img_kv` key on first list.
- **`[[default]].ts` / `[[path]].ts`** naming is EdgeOne Pages convention (catch-all and dynamic route functions). Do not rename.
- **No tests exist** in this project.

## Environment variables (required for deployment)

These are set in EdgeOne console — not in code or `.env` files:

| Variable          | Example                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `BASE_IMG_URL`    | `https://img.example.com/` (trailing slash optional)                                   |
| `SLUG_IMG`        | `username/repo-name`                                                                   |
| `TOKEN_IMG`       | CNB token with image upload scope (for imgs endpoint)                                  |
| `TOKEN_FILE`      | CNB token with `repo-notes:rw` scope (for files endpoint, arbitrary files)             |
| `TOKEN_DELETE`    | CNB token with `repo-manage:rw` scope (for deleting uploaded imgs/files); optional     |
| `UPLOAD_PASSWORD` | Upload password (doubles as JWT secret; if empty/unset, login and sign endpoints fail) |

## Code conventions

- **Prettier**: no semicolons, single quotes, 100 char print width, 2-space indent
- **LF** line endings (`.gitattributes` enforces `eol=lf`)
- **Path alias**: `@` → `./src` (configured in `vite.config.ts`, `tsconfig.json`)
- **VS Code**: use Volar (not Vetur), ESLint, Prettier extensions (see `.vscode/extensions.json`)
