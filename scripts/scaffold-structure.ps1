# Scaffold folder and file structure for pgasketsinv-final\src
param()

$ErrorActionPreference = 'Stop'

$root = 'c:\Users\luiso\OneDrive\Documentos\Windsurf Codes\pgasketsinv-final\src'

$dirs = @(
  'app',
  'app\inventory',
  'app\inventory\receiving',
  'app\inventory\work-orders',
  'app\inventory\movements',

  'features\inventory\components\Dashboard',
  'features\inventory\components\SKUManager',
  'features\inventory\components\VendorManager',
  'features\inventory\hooks',
  'features\inventory\services',
  'features\inventory\store',
  'features\inventory\types',
  'features\inventory\utils',

  'features\receiving\components\ReceivingForm',
  'features\receiving\components\DamageAssessment',
  'features\receiving\components\PendingReceipts',
  'features\receiving\hooks',
  'features\receiving\services',
  'features\receiving\types',

  'features\work-orders',
  'features\movements',

  'shared\components\Layout',
  'shared\components\ErrorBoundary',
  'shared\components\LoadingStates',
  'shared\components\DataTable',
  'shared\hooks',
  'shared\services',
  'shared\utils',

  'lib\api',
  'lib\store',
  'lib\schemas',

  '__tests__\integration',
  '__tests__\e2e',
  '__tests__\fixtures'
)

$files = @(
  # app
  'app\layout.tsx',
  'app\page.tsx',
  'app\inventory\layout.tsx',
  'app\inventory\page.tsx',
  'app\inventory\receiving\page.tsx',
  'app\inventory\work-orders\page.tsx',
  'app\inventory\movements\page.tsx',

  # features/inventory/components/Dashboard
  'features\inventory\components\Dashboard\Dashboard.tsx',
  'features\inventory\components\Dashboard\Dashboard.test.tsx',
  'features\inventory\components\Dashboard\MetricCard.tsx',
  'features\inventory\components\Dashboard\InventoryTable.tsx',
  'features\inventory\components\Dashboard\index.ts',

  # features/inventory/components/SKUManager
  'features\inventory\components\SKUManager\SKUManager.tsx',
  'features\inventory\components\SKUManager\SKUForm.tsx',
  'features\inventory\components\SKUManager\SKUTable.tsx',
  'features\inventory\components\SKUManager\SKUManager.test.tsx',

  # features/inventory/components/VendorManager
  'features\inventory\components\VendorManager\VendorManager.tsx',
  'features\inventory\components\VendorManager\VendorForm.tsx',
  'features\inventory\components\VendorManager\VendorAutocomplete.tsx',

  # features/inventory/hooks
  'features\inventory\hooks\useInventory.ts',
  'features\inventory\hooks\useFIFO.ts',
  'features\inventory\hooks\useInventoryMetrics.ts',

  # features/inventory/services
  'features\inventory\services\inventory.service.ts',
  'features\inventory\services\inventory.service.test.ts',

  # features/inventory/store
  'features\inventory\store\inventory.store.ts',
  'features\inventory\store\inventory.selectors.ts',

  # features/inventory/types
  'features\inventory\types\inventory.types.ts',

  # features/inventory/utils
  'features\inventory\utils\fifo.utils.ts',
  'features\inventory\utils\inventory.utils.ts',

  # shared
  'shared\hooks\useDebounce.ts',
  'shared\hooks\useInfiniteScroll.ts',
  'shared\hooks\useLocalStorage.ts',
  'shared\services\api.service.ts',
  'shared\services\auth.service.ts',
  'shared\services\export.service.ts',
  'shared\utils\date.utils.ts',
  'shared\utils\currency.utils.ts',
  'shared\utils\validation.utils.ts',

  # lib
  'lib\api\client.ts',
  'lib\api\interceptors.ts',
  'lib\api\error-handler.ts',
  'lib\store\root.store.ts',
  'lib\schemas\inventory.schema.ts',
  'lib\schemas\vendor.schema.ts'
)

# Create directories
foreach ($d in $dirs) {
  $path = Join-Path $root $d
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

# Create files
foreach ($f in $files) {
  $path = Join-Path $root $f
  if (-not (Test-Path $path)) {
    # Ensure parent directory exists
    $parent = Split-Path $path -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    New-Item -ItemType File -Path $path -Force | Out-Null
  }
}

Write-Host "Estrutura criada em: $root"
