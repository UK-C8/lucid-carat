# LucidCarat

A vertical SaaS for diamond houses in Surat — AI-powered grading, pricing, provenance, and B2B catalog. Built by Centr8 LLP.

## Monorepo structure

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 14 (App Router) — the main web application |
| `services/grading` | Python/FastAPI — CV 4Cs grading service (PyTorch) |
| `services/pricing` | Python/FastAPI — price forecasting service (XGBoost) |
| `infra/` | Terraform — AWS ECS/Fargate, RDS, S3, Redis (ap-south-1) |
| `packages/shared/` | Shared TypeScript types and schemas |

## Before doing any work

**Read `CLAUDE.md` in full.** It contains the product brief, hard out-of-scope boundaries, tech stack decisions, phase gates, and working conventions. Every contributor and AI assistant must read it before touching code.

## Running the scaffolds

```bash
# Web app
cd apps/web && npm install && npm run dev

# Grading service
cd services/grading && pip install -r requirements.txt && uvicorn main:app --reload --port 8001

# Pricing service
cd services/pricing && pip install -r requirements.txt && uvicorn main:app --reload --port 8002
```

