/**
 * Feature Flags for Journal Export History
 * Enables safe, incremental rollout of new functionality
 */

export interface FeatureFlags {
  // Core history functionality
  JOURNAL_HISTORY_TRACKING: boolean;    // Safe to enable - just records data
  JOURNAL_HISTORY_UI: boolean;          // UI components (dev only initially)
  
  // Advanced features (later phases)
  JOURNAL_PREMIUM_ANALYTICS: boolean;   // Charts and insights
  JOURNAL_EXPORT_ACTIONS: boolean;      // Re-download, email, etc.
  JOURNAL_AUTO_SYNC: boolean;           // Background sync features
  
  // Performance and monitoring
  PERFORMANCE_MONITORING: boolean;       // Telemetry collection
  ENHANCED_ERROR_TRACKING: boolean;     // Detailed error reporting

  // Inventory features (new)
  INVENTORY_CATEGORIES: boolean;         // Manage Categories feature (DEV only initially)
}

// Environment-based defaults (safety first)
const getDefaultFlags = (): FeatureFlags => {
  const isDev = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  
  return {
    // Safe features (read-only, non-breaking)
    JOURNAL_HISTORY_TRACKING: true,        // Always safe
    PERFORMANCE_MONITORING: !isTest,       // Disabled in tests
    
    // UI features (dev only initially)
    JOURNAL_HISTORY_UI: isDev,             // Dev environment only
    ENHANCED_ERROR_TRACKING: isDev,        // Dev debugging
    
    // Advanced features (disabled by default)
    JOURNAL_PREMIUM_ANALYTICS: false,      // Future release
    JOURNAL_EXPORT_ACTIONS: false,         // Future release
    JOURNAL_AUTO_SYNC: false,              // Future release

    // Inventory features
    INVENTORY_CATEGORIES: true,            // Now enabled in production
  };
};

// Runtime feature flags (can be overridden)
let FEATURE_FLAGS: FeatureFlags = getDefaultFlags();

/**
 * Get current feature flag value
 */
export function getFeatureFlag(flag: keyof FeatureFlags): boolean {
  return FEATURE_FLAGS[flag];
}

/**
 * Update feature flag at runtime (for testing/admin control)
 */
export function setFeatureFlag(flag: keyof FeatureFlags, value: boolean): void {
  console.info(`🎛️ Feature flag updated: ${flag} = ${value}`);
  FEATURE_FLAGS = { ...FEATURE_FLAGS, [flag]: value };
}

/**
 * Check if user should see enhanced journal features
 */
export function shouldShowJournalHistory(): boolean {
  // Development environment
  if (process.env.NODE_ENV === 'development') return true;
  
  // Beta users flag
  if (typeof window !== 'undefined') {
    const betaFlag = localStorage.getItem('pgaskets-beta-features');
    if (betaFlag === 'enabled') return true;
  }
  
  // Feature flag
  return getFeatureFlag('JOURNAL_HISTORY_UI');
}

/**
 * Safe wrapper for feature-flagged code
 */
export function withFeatureFlag<T>(
  flag: keyof FeatureFlags,
  enabledFn: () => T,
  disabledFn: () => T
): T {
  try {
    return getFeatureFlag(flag) ? enabledFn() : disabledFn();
  } catch (error) {
    console.error(`Feature flag ${flag} failed:`, error);
    return disabledFn(); // Always fallback to safe behavior
  }
}

/**
 * Enable beta features for current user
 */
export function enableBetaFeatures(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('pgaskets-beta-features', 'enabled');
    console.info('🧪 Beta features enabled for this user');
  }
}

/**
 * Disable beta features for current user
 */
export function disableBetaFeatures(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('pgaskets-beta-features');
    console.info('🧪 Beta features disabled for this user');
  }
}

/**
 * Get all current feature flag states (for debugging)
 */
export function getAllFeatureFlags(): FeatureFlags {
  return { ...FEATURE_FLAGS };
}

/**
 * Reset all feature flags to defaults
 */
export function resetFeatureFlags(): void {
  FEATURE_FLAGS = getDefaultFlags();
  console.info('🔄 Feature flags reset to defaults');
}

// Development helpers
if (process.env.NODE_ENV === 'development') {
  // Expose to window for easy testing
  (window as any).__pgaskets_features = {
    get: getFeatureFlag,
    set: setFeatureFlag,
    all: getAllFeatureFlags,
    reset: resetFeatureFlags,
    enableBeta: enableBetaFeatures,
    disableBeta: disableBetaFeatures
  };
  
  // Expose database testing tools
  import('../features/inventory/scripts/testDatabase').then(() => {
    // This will set up window.__databaseTests automatically
  }).catch(error => {
    console.warn('Could not load database tests:', error);
  });
  
  console.info('🛠️ Feature flags available at window.__pgaskets_features');
  console.info('🧪 Database tests will be available at window.__databaseTests');
}