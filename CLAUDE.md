# PGaskets Inventory System - Development Guide

## 🏗️ Project Overview

This is a React + TypeScript inventory management system for Premier Gaskets, built with Vite, Supabase backend, and deployed on Vercel with optional Cloudflare Workers API.

## 🛠️ Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **Backend**: Supabase (PostgreSQL + Auth + RLS)
- **Styling**: Tailwind CSS + shadcn/ui components
- **State**: React hooks + TanStack Query
- **Deployment**: Vercel (frontend) + Cloudflare Workers (API)
- **Data Export**: xlsx library for Excel exports

## 📁 Project Structure

```
src/
├── components/
│   ├── auth/                    # Authentication components
│   │   ├── AuthContext.tsx      # Auth state management
│   │   ├── LoginPage.tsx        # Login form
│   │   └── ProtectedRoute.tsx   # Route protection
│   ├── ui/                      # shadcn/ui components
│   └── common/                  # Shared components
├── features/
│   └── inventory/
│       ├── components/          # Feature-specific components
│       ├── pages/               # Main application pages
│       │   ├── Wireframe.tsx    # Main dashboard
│       │   ├── Movements.tsx    # Movement tracking
│       │   ├── Receiving.tsx    # Receiving interface
│       │   └── WorkOrder.tsx    # Work order management
│       ├── services/            # Backend integration
│       │   ├── inventory.adapter.ts # Service adapter layer
│       │   └── supabase/        # Supabase services
│       └── types/               # TypeScript definitions
└── lib/
    └── supabase.ts             # Supabase client config
```

## 🔐 Authentication System

### Implementation
- **Login/Logout**: Email + password authentication via Supabase Auth
- **Route Protection**: ProtectedRoute wrapper redirects unauthenticated users
- **Session Management**: Persistent sessions with automatic refresh
- **User Display**: Shows logged user email in header with logout button

### Configuration Required
1. **Supabase Dashboard** → Authentication → Settings:
   - ✅ Enable email provider
   - ✅ Disable email confirmations (for simplicity)
   - Add redirect URLs: `localhost:5173-5175`, `pgaskets-inv.vercel.app`

2. **Admin User Creation**:
   - Email: `admin@pgaskets.com`
   - Password: `pgaskets123`
   - Auto-confirm: ON

### Routes
- `/` → Redirects to `/app`
- `/login` → Login page
- `/app` → Protected dashboard (requires authentication)

## 💾 Database Schema (Supabase)

### Core Tables
- **skus**: Product master data with FIFO inventory tracking
- **vendors**: Supplier information  
- **movements**: All inventory transactions (RECEIVE, ISSUE, WASTE, PRODUCE)
- **fifo_layers**: Cost layer tracking for FIFO calculations
- **work_orders**: Production orders linking inputs to outputs

### Key Features
- **Row Level Security (RLS)**: Currently disabled for development
- **Soft Deletes**: Records marked as `active: false` instead of deletion
- **FIFO Cost Tracking**: Automatic cost layer management
- **Audit Trail**: Movement tracking with reversal capabilities

## 🔄 Backend Integration Patterns

### Service Adapter Layer
The `inventory.adapter.ts` provides a clean interface between frontend and Supabase:

```typescript
// SKU Operations
await skuOperations.getAllSKUs()
await skuOperations.createSKU(skuData)
await skuOperations.updateSKU(id, updates)
await skuOperations.deleteSKU(id) // Soft delete

// Vendor Operations  
await vendorOperations.getAllVendors()
await vendorOperations.createVendor(vendorData)
await vendorOperations.deleteVendor(id) // Soft delete

// Movement Operations
await movementOperations.getMovements(filters)
await movementOperations.createReceiveMovement(params)
await movementOperations.deleteMovement(id, options)
```

### Type Mapping
Frontend types are mapped to backend schemas in the adapter layer to maintain clean separation.

## 📊 Key Features

### Dashboard
- **Real-time KPIs**: Inventory value, turnover, days of inventory
- **Traffic Light System**: Visual indicators for stock levels below minimum
- **Excel Export**: Filtered exports with pure numeric values (no currency symbols)
- **Period Filtering**: Today, last 7 days, month, quarter, custom range

### Inventory Management
- **SKU Master**: Create, edit, delete SKUs with stock protection
- **Vendor Management**: Supplier database with contact information
- **Stock Protection**: Prevents deletion of SKUs with current inventory
- **FIFO Costing**: Automatic average cost calculation

### Movement Tracking
- **Transaction Log**: All inventory movements with filtering
- **Excel Export**: Movement history with filter confirmation
- **Automatic Sorting**: Newest entries first
- **Deletion Controls**: Confirmation dialogs with random animal tokens

### Work Orders
- **Production Tracking**: Link raw materials to finished goods
- **FIFO Planning**: Automatic cost calculation for material consumption
- **Multi-output Support**: Handle waste and main products

## 🚀 Development Workflow

### Local Development
```bash
npm install
npm run dev  # Starts on localhost:5173-5175
```

### Database Migrations
```bash
npx supabase db push  # Apply schema changes
```

### Production Build
```bash
npm run build
git add . && git commit -m "Your changes"
git push origin main  # Triggers Vercel auto-deploy
```

## 🌐 Deployment Architecture

### Frontend (Vercel)
- **Auto-deploy**: Every push to `main` branch
- **Environment Variables**: 
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
- **URL**: https://pgaskets-inv.vercel.app

### Optional API Layer (Cloudflare Workers)
- **Worker**: `worker.js` with Supabase integration
- **Secrets**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- **Deploy**: `npx wrangler deploy`
- **URL**: https://pgaskets-inv-api.luisotaviomoretti.workers.dev

## 🐛 Common Issues & Solutions

### Authentication Issues
- **"Email logins are disabled"**: Enable email provider in Supabase Auth settings
- **Redirect loops**: Check redirect URLs in Supabase configuration
- **Session not persisting**: Verify Supabase client configuration

### Data Issues  
- **SKU not deleting visually**: Soft delete working correctly, refresh page to confirm
- **Missing data**: Check RLS policies and ensure user has proper permissions
- **Export showing currency symbols**: Fixed - Excel exports now show pure numbers

### Build Issues
- **Missing CSS**: Remove invalid CSS imports from main.tsx
- **Environment variables**: Ensure all VITE_ prefixed vars are configured

## 🔧 Environment Setup

### Required Environment Variables
```env
VITE_SUPABASE_URL=https://errkjwfxrbkfajngshkn.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Development Tools
- Node.js 18+
- Git
- Supabase CLI (optional)
- Wrangler CLI (for Cloudflare Workers)

## 📋 Testing Checklist

### Authentication Flow
- [ ] Unauthenticated user redirected to login
- [ ] Valid login redirects to dashboard  
- [ ] Invalid login shows error message
- [ ] Logout returns to login page
- [ ] Session persists on page refresh

### Core Functionality
- [ ] SKU creation, editing, deletion
- [ ] Vendor management operations
- [ ] Movement tracking and filtering
- [ ] Excel exports working without currency symbols
- [ ] Dashboard KPIs calculating correctly

### Production Deployment
- [ ] Vercel environment variables configured
- [ ] Build completes successfully
- [ ] Authentication working on production URL
- [ ] All features functional on deployed site

## 📞 Support

For development issues:
- Check this CLAUDE.md file
- Review Supabase dashboard for auth/data issues
- Verify environment variables in Vercel dashboard
- Check browser console for frontend errors
- Review Supabase logs for backend issues

## 🏷️ Version History

- **v1.0**: Initial inventory management system
- **v1.1**: Backend integration with Supabase
- **v1.2**: Excel export functionality
- **v1.3**: Authentication system implementation
- **v1.4**: Production deployment and optimization