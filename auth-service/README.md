# PolicyWise Auth Service

Centralised AWS Cognito authentication service for PolicyWise. Runs on port 3000.

## Setup

```bash
cd auth-service
npm install
cp .env.example .env
# Fill in your AWS Cognito and Google credentials in .env
npm run start:dev
```

## Environment Variables

See `.env.example` for all required variables.

## Endpoints

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| POST | /auth/signup | Register new user | No |
| POST | /auth/signin | Sign in | No |
| POST | /auth/google | Google Sign-In | No |
| POST | /auth/refresh | Refresh token | No |
| GET | /auth/me | Get current user | Yes |
| POST | /auth/signout | Sign out | Yes |
| GET | /users/profile | Get profile | Yes |
| PUT | /users/profile | Update profile | Yes |
| GET | /health | Health check | No |
