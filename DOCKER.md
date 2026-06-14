# CVForge Docker Setup

## Run everything

```bash
docker compose up --build
```

## URLs

- Frontend (CV builder, auth, recruiter, career predictor): `http://localhost:8080`
- API: `https://justanintern.vercel.app`
- DB exposed on host: `localhost:5433`

## Notes

- The Postgres schema is initialized automatically from `cvforge-backend/sql/auth_schema.sql` on first run.
- Auth pages use `https://justanintern.vercel.app` by default for API calls.
- To point frontend auth/recruiter pages to another API, set in browser console:

```js
localStorage.setItem('cvforge_api_base', 'https://your-api-host');
```
