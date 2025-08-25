# Playwright Performance Testing

This directory contains Playwright tests for the PGaskets Inventory System, focusing on performance and functionality testing.

## Test Structure

- **navigation.spec.ts** - Basic navigation and routing tests
- **auth.spec.ts** - Authentication flow and security tests  
- **performance.spec.ts** - Core Web Vitals and loading performance tests
- **inventory-performance.spec.ts** - Application-specific performance tests
- **example.spec.ts** - Template/example tests (can be removed)

## Running Tests

### All Tests
```bash
npm run test:playwright
```

### Performance Tests Only
```bash
npm run test:performance
```

### Authentication Tests Only
```bash
npm run test:auth
```

### Interactive Mode (with browser UI)
```bash
npm run test:playwright:ui
```

### View Test Reports
```bash
npm run test:playwright:report
```

## Performance Benchmarks

The tests include performance assertions for:

- **Page Load Time**: < 3 seconds
- **First Contentful Paint**: < 2 seconds  
- **Time to Interactive**: < 5 seconds
- **Authentication**: < 5 seconds
- **Data Filtering**: < 2 seconds
- **Form Submission**: < 5 seconds
- **JavaScript Bundle**: < 2MB
- **Memory Usage**: < 100MB

## Test Configuration

Tests are configured in `playwright.config.ts` with:

- Multiple browser support (Chrome, Firefox, Safari, Edge)
- Mobile device testing (iPhone, Pixel)
- Automatic dev server startup
- Screenshot and video on failure
- Trace collection for debugging

## Environment Setup

Tests require the application to be running locally. The dev server is automatically started via the `webServer` configuration.

Environment variables needed:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## CI/CD Integration

GitHub Actions workflow in `.github/workflows/playwright.yml` runs tests on:
- Push to main/develop branches
- Pull requests

Test reports are automatically uploaded as artifacts.

## Debugging

For failed tests:
1. Check the HTML report: `npm run test:playwright:report`
2. View screenshots in `test-results/`
3. Check traces for detailed debugging
4. Run in headed mode: `npx playwright test --headed`

## Adding New Tests

When adding new tests:
1. Follow existing naming conventions
2. Include performance assertions where applicable  
3. Use the login helper in `beforeEach` for authenticated tests
4. Add descriptive test names and console.log performance metrics