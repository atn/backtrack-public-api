# Bactrack API

Backend API for **Bactrack** — a platform that scans email receipts, identifies items with resale potential, and helps users list them on eBay.

## Tech Stack

- **Runtime:** Node.js + Fastify
- **Database:** PostgreSQL + Prisma ORM
- **AI:** OpenAI API for receipt parsing and item analysis
- **Integrations:** Gmail API, eBay API, Expo Push Notifications
- **Infrastructure:** Docker, Kubernetes

## Architecture

```
src/
├── controllers/    # Request handlers
├── routes/         # Route definitions
├── services/       # Business logic & external API integrations
├── middleware/      # Auth & admin middleware
├── lib/            # Prisma client
└── utils/          # Logger
```

### Core Flow

1. User links their Gmail account via OAuth
2. Background service syncs and scans emails for receipts
3. OpenAI extracts item details (name, price, vendor, date)
4. Items are scored for resale potential and surfaced in a personalized feed
5. Users can list items directly to eBay through the app

## Setup

```bash
# Install dependencies
npm install

# Set up environment variables
cp env.example .env
# Fill in: DATABASE_URL, JWT_SECRET, OPENAI_API_KEY, Google OAuth creds, eBay API creds

# Run database migrations
npx prisma migrate deploy

# Start development server
npm run dev
```

## API Routes

| Prefix | Description |
|--------|-------------|
| `/api/auth` | Authentication (signup, login, Google OAuth) |
| `/api/gmail` | Gmail account linking and sync |
| `/api/receipts` | Receipt processing |
| `/api/user-receipts` | Receipt retrieval |
| `/api/receipt-items` | Receipt item management |
| `/api/resale-feed` | Personalized resale feed |
| `/api/ebay` | eBay integration (policies, listings) |
| `/api/admin` | Admin endpoints |
| `/healthz` | Liveness check |
| `/readyz` | Readiness check |
