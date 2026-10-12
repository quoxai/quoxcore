# Contributing to Quoxflow

## Development Setup

```bash
git clone https://github.com/quoxai/quoxflow.git
cd quoxflow
npm install
npm test
```

## Running Tests

```bash
npm test          # Run all tests
npm run build     # Build TypeScript
npm run server    # Start API server
```

## Pull Requests

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit with a clear message
6. Push and open a PR

## Code Style

- TypeScript strict mode
- No `any` types without justification
- Tests for new features

## Architecture

- `src/core/` - Envelope and workflow types
- `src/executors/` - Node type implementations
- `src/pipeline/` - AOCL control layers
- `src/api/` - Hono REST API
- `src/policy/` - Policy engine
- `src/approval/` - Approval workflows
- `src/evidence/` - Evidence storage
