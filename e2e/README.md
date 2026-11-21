# End-to-end checks

Runs the manager page and the phone app's server calls against a local copy of the backend
(PostgreSQL with the real migrations, PostgREST, and a stand-in for Supabase Auth).
Nothing here touches the live Supabase project.

## One-time setup

```sh
mkdir -p e2e/.bin
curl -L https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz | tar -xJ -C e2e/.bin
pip install playwright openpyxl
```

The scripts launch Chrome from `/usr/bin/google-chrome`.

## Run

```sh
node e2e/stack.mjs                                   # backend on http://localhost:54321, code 123456 for any email
VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_PUBLISHABLE_KEY=local-anon \
  npx vite --config apps/manager/vite.config.ts apps/manager --port 5173

cd e2e   # in order, on a fresh backend:
python3 manager_setup.py && python3 manager_people.py && python3 manager_schedule.py \
  && python3 manager_schedule2.py && python3 manager_payroll.py && python3 manager_part3.py \
  && python3 manager_misc.py && node mobile_api.mjs
```

Each script prints what it checked and any browser errors, failed requests or crashes.
Screenshots go to `e2e/out/`.
