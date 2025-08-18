# Supabase Setup Guide

## Prerequisites

1. **Supabase CLI**: Install the Supabase CLI
   ```bash
   npm install -g supabase
   ```

2. **Docker**: Required for local development
   - Download from [docker.com](https://www.docker.com/products/docker-desktop/)

## Setup Steps

### 1. Create Supabase Project

**Option A: Cloud Setup (Recommended for Production)**
1. Go to [supabase.com](https://supabase.com)
2. Create new project: `pgasketsinv-final`
3. Choose region closest to your users
4. Note down the project URL and API keys

**Option B: Local Development**
```bash
# Initialize Supabase in project
supabase init

# Start local development stack
supabase start
```

### 2. Configure Environment

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in your Supabase credentials:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

### 3. Run Database Migrations

**For Cloud Project:**
```bash
# Link to your cloud project
supabase link --project-ref your-project-ref

# Run migrations
supabase db push
```

**For Local Development:**
```bash
# Migrations run automatically with supabase start
# Or manually apply:
supabase db reset
```

### 4. Verify Setup

1. **Check tables created:**
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public' 
   ORDER BY table_name;
   ```

2. **Verify seed data:**
   ```sql
   SELECT COUNT(*) as sku_count FROM skus;
   SELECT COUNT(*) as vendor_count FROM vendors;
   SELECT COUNT(*) as layer_count FROM fifo_layers;
   ```

3. **Test inventory summary view:**
   ```sql
   SELECT * FROM inventory_summary LIMIT 5;
   ```

### 5. Install Dependencies

```bash
# Install Supabase client
npm install @supabase/supabase-js

# Install additional dependencies for backend integration
npm install @supabase/auth-helpers-nextjs
```

## Database Schema Overview

### Core Tables
- **skus**: Stock Keeping Units (RAW/SELLABLE materials)
- **vendors**: Supplier information with autocomplete support
- **fifo_layers**: FIFO cost layers for inventory valuation
- **movements**: All inventory transactions (RECEIVE/ISSUE/WASTE/PRODUCE)
- **work_orders**: Production orders with multi-SKU consumption
- **layer_consumptions**: Links movements to specific FIFO layers
- **receiving_batches**: Groups related receiving movements

### Key Features
- **FIFO Enforcement**: Automatic oldest-first consumption
- **Real-time Updates**: Triggers maintain data consistency
- **Performance Indexes**: Optimized for common queries
- **Row Level Security**: Authentication-based access control
- **Aggregated Views**: Pre-computed inventory summaries

## Troubleshooting

### Common Issues

1. **Migration Fails**
   ```bash
   # Reset and retry
   supabase db reset
   ```

2. **Connection Issues**
   - Verify `.env.local` credentials
   - Check network connectivity
   - Ensure project is not paused (cloud)

3. **Permission Errors**
   - Verify RLS policies are correctly applied
   - Check user authentication status

### Useful Commands

```bash
# View local dashboard
supabase status

# Reset local database
supabase db reset

# Generate TypeScript types
supabase gen types typescript --local > types/supabase.ts

# View logs
supabase logs
```

## Next Steps

After successful setup:

1. **Test API Connectivity**: Run basic queries from frontend
2. **Implement Service Layer**: Create Supabase client wrapper
3. **Add Real-time Subscriptions**: For inventory updates
4. **Configure Authentication**: Set up user management
5. **Deploy to Production**: Link cloud project for deployment

## Security Notes

- Never commit `.env.local` to version control
- Use service role key only for server-side operations
- Implement proper RLS policies for production
- Regularly rotate API keys
- Monitor usage and set up alerts
