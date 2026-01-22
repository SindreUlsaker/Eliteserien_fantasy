# Eliteserien Fantasy

A fullstack web application for Eliteserien Fantasy that fetches data from public Fantasy APIs, stores and analyzes it in a database, and presents it in a modern React-based dashboard for statistics, team optimization, and decision support for players.

## Architecture Overview

This project is a monorepo built with pnpm workspaces, containing:

- **Frontend** (`apps/web`): Next.js application with TypeScript
- **Backend** (`apps/api`): Fastify API server with TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Infrastructure**: Docker Compose for local development

```mermaid
graph TB
    subgraph "Frontend"
        Web[Next.js App<br/>Port 3000]
    end
    
    subgraph "Backend"
        API[Fastify API<br/>Port 3001]
    end
    
    subgraph "Database"
        DB[(PostgreSQL<br/>Port 5432)]
        Redis[(Redis<br/>Port 6379<br/>Future)]
    end
    
    subgraph "External"
        FantasyAPI[Fantasy APIs<br/>Future]
    end
    
    Web -->|HTTP| API
    API -->|Prisma| DB
    API -.->|Future| Redis
    API -.->|Future| FantasyAPI
    
    style Web fill:#61dafb
    style API fill:#00d8ff
    style DB fill:#336791
    style Redis fill:#dc382d
```

## Tech Stack

### Core Technologies

- **Monorepo**: pnpm workspaces for efficient dependency management
- **Frontend**: Next.js 14+ (App Router), React 18, TypeScript
- **Backend**: Fastify, Node.js, TypeScript
- **Database**: PostgreSQL 16
- **ORM**: Prisma
- **Containerization**: Docker + Docker Compose

### Development Tools

- **Linting**: ESLint with TypeScript support
- **Formatting**: Prettier
- **Testing**: 
  - Unit: Vitest
  - E2E: Playwright
- **CI/CD**: GitHub Actions
- **Git Hooks**: Husky + lint-staged
- **Logging**: pino (structured logging)

### Why These Tools?

- **pnpm workspaces**: Efficient monorepo dependency management, shared dependencies, faster installs
- **Next.js**: React framework with SSR, routing, API routes (future), excellent DX
- **Fastify**: High-performance Node.js framework, plugin ecosystem, TypeScript support
- **Prisma**: Type-safe ORM, migrations, excellent DX, auto-generated types
- **PostgreSQL**: Robust relational database, JSON support, ACID compliance
- **Docker Compose**: Local dev environment consistency, easy DB setup
- **ESLint**: Code quality, catch errors early, consistent style
- **Prettier**: Automatic code formatting, eliminates style debates
- **Vitest**: Fast unit testing, Vite-powered, TypeScript native
- **Playwright**: Reliable E2E testing, multiple browsers, auto-waiting
- **Husky**: Git hooks made easy, enforce quality before commit
- **lint-staged**: Only lint/format changed files, faster pre-commit
- **pino**: Fast structured logging, production-ready
- **GitHub Actions**: CI/CD, automated quality checks

## Project Structure

```
Eliteserien_fantasy/
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions CI pipeline
├── .husky/
│   └── pre-commit              # Git pre-commit hook
├── apps/
│   ├── api/                    # Fastify backend
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   └── health.ts   # Health check endpoint
│   │   │   └── index.ts        # Server bootstrap
│   │   ├── .eslintrc.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                    # Next.js frontend
│       ├── app/
│       │   ├── layout.tsx      # Root layout
│       │   ├── page.tsx        # Home page
│       │   └── globals.css
│       ├── .eslintrc.json
│       ├── next.config.js
│       ├── package.json
│       └── tsconfig.json
├── packages/                   # Shared packages (future)
├── prisma/
│   ├── migrations/            # Database migrations
│   └── schema.prisma          # Prisma schema
├── .editorconfig
├── .env.example               # Environment variables template
├── .gitignore
├── .lintstagedrc.json
├── .prettierignore
├── .prettierrc.json
├── docker-compose.yml         # Docker services (PostgreSQL, Redis)
├── .eslintrc.json
├── package.json               # Root workspace config
├── pnpm-workspace.yaml
├── playwright.config.ts
├── README.md
├── tsconfig.base.json
└── vitest.config.ts
```

## Prerequisites

Before setting up the project, ensure you have the following installed:

- **Node.js** 18+ ([Download](https://nodejs.org/))
- **pnpm** 8+ ([Installation guide](https://pnpm.io/installation))
- **Docker Desktop** ([Download](https://www.docker.com/products/docker-desktop/))
- **Git** ([Download](https://git-scm.com/))

### Installing pnpm

If you don't have pnpm installed:

```bash
# Using npm
npm install -g pnpm

# Using Homebrew (macOS)
brew install pnpm

# Using PowerShell (Windows)
iwr https://get.pnpm.io/install.ps1 -useb | iex
```

## Local Development Setup

### Step 1: Clone and Initialize

```bash
# Clone the repository (or navigate to your project directory)
cd Eliteserien_fantasy

# Initialize git if not already done
git init
```

### Step 2: Install Dependencies

```bash
# Install all dependencies for all workspaces
pnpm install
```

### Step 3: Environment Configuration

```bash
# Copy the example environment file
cp .env.example .env
```

Edit `.env` and ensure the following variables are set:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/eliteserien_fantasy?schema=public
API_PORT=3001
API_HOST=0.0.0.0
WEB_PORT=3000
NODE_ENV=development
```

### Step 4: Start Docker Services

```bash
# Start PostgreSQL and Redis in detached mode
docker-compose up -d

# Verify services are running
docker-compose ps
```

### Step 5: Database Setup

```bash
# Generate Prisma Client
pnpm db:generate

# Run database migrations
pnpm db:migrate
```

### Step 6: Start Development Servers

```bash
# Start both web and API servers concurrently
pnpm dev
```

This will start:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001

### Step 7: Verify Everything Works

1. **Frontend**: Open http://localhost:3000 - you should see "Eliteserien Fantasy – WIP"
2. **API Health Check**: Open http://localhost:3001/health - you should see:
   ```json
   {
     "status": "ok",
     "database": "connected",
     "timestamp": "2024-01-01T00:00:00.000Z"
   }
   ```

## Available Scripts

### Root Level Scripts

- `pnpm dev` - Start both web and API development servers
- `pnpm build` - Build all applications for production
- `pnpm lint` - Lint all workspaces
- `pnpm lint:fix` - Lint and auto-fix issues
- `pnpm typecheck` - Type check all TypeScript code
- `pnpm test` - Run unit tests with Vitest
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:e2e` - Run E2E tests with Playwright
- `pnpm test:e2e:ui` - Run E2E tests with Playwright UI
- `pnpm format` - Format all code with Prettier
- `pnpm format:check` - Check code formatting
- `pnpm db:migrate` - Run Prisma migrations
- `pnpm db:studio` - Open Prisma Studio (database GUI)
- `pnpm db:generate` - Generate Prisma Client

### Workspace-Specific Scripts

You can run scripts for specific workspaces:

```bash
# Run dev server for web only
pnpm --filter web dev

# Run dev server for API only
pnpm --filter api dev

# Lint only the API
pnpm --filter api lint
```

## Docker Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f

# Restart services
docker-compose restart

# Remove volumes (⚠️ deletes data)
docker-compose down -v
```

## Database Management

### Prisma Studio

Open a visual database browser:

```bash
pnpm db:studio
```

This opens Prisma Studio at http://localhost:5555

### Creating Migrations

```bash
# Create a new migration after schema changes
pnpm db:migrate

# Push schema changes without migration (dev only)
pnpm --filter api db:push
```

## Testing

### Unit Tests

```bash
# Run all unit tests
pnpm test

# Run in watch mode
pnpm test:watch

# Run with coverage
pnpm test -- --coverage
```

### E2E Tests

```bash
# Run E2E tests (requires dev servers running)
pnpm test:e2e

# Run with UI
pnpm test:e2e:ui

# Run specific test file
pnpm test:e2e tests/homepage.spec.ts
```

## Code Quality

### Linting

```bash
# Check for linting errors
pnpm lint

# Auto-fix linting errors
pnpm lint:fix
```

### Formatting

```bash
# Format all code
pnpm format

# Check formatting (CI)
pnpm format:check
```

### Pre-commit Hooks

Husky automatically runs lint-staged before each commit:
- Lints and formats TypeScript/JavaScript files
- Formats JSON, YAML, and Markdown files

## CI/CD

GitHub Actions automatically runs on push/PR to `main` or `develop`:

1. **Lint**: Checks code quality
2. **Type Check**: Validates TypeScript types
3. **Test**: Runs unit tests
4. **Build**: Builds all applications

View workflows in `.github/workflows/ci.yml`

## Troubleshooting

### Port Already in Use

If ports 3000, 3001, 5432, or 6379 are already in use:

1. Change ports in `.env` and `docker-compose.yml`
2. Or stop the conflicting service

### Database Connection Issues

```bash
# Check if PostgreSQL is running
docker-compose ps

# View PostgreSQL logs
docker-compose logs postgres

# Restart PostgreSQL
docker-compose restart postgres
```

### Prisma Client Not Generated

```bash
# Generate Prisma Client
pnpm db:generate
```

### Module Resolution Errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules apps/*/node_modules
pnpm install
```

## Next Steps

This is the initial scaffold. Future development will include:

- [ ] Fantasy API integrations
- [ ] Data models and database schema
- [ ] Authentication and authorization
- [ ] Background jobs for data sync
- [ ] GraphQL API layer
- [ ] Dashboard UI components
- [ ] Team optimization algorithms
- [ ] Statistics and analytics

## Contributing

1. Create a feature branch
2. Make your changes
3. Ensure all tests pass: `pnpm test && pnpm test:e2e`
4. Ensure linting passes: `pnpm lint`
5. Commit (pre-commit hooks will run automatically)
6. Push and create a pull request

## License

[Add your license here]

## Support

[Add support/contact information here]
