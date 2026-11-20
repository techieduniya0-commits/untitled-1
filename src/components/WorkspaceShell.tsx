import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Database,
  FileBarChart2,
  FolderSearch,
  History,
  Home,
  LayoutDashboard,
  Menu,
  Settings,
  Upload,
  X,
} from 'lucide-react';
import { PremiumButton } from './PremiumUi';
import { TruthLensLogo } from './TruthLensLogo';

export type WorkspaceTab =
  | 'overview'
  | 'upload'
  | 'analyses'
  | 'history'
  | 'reports'
  | 'datasets'
  | 'settings'
  | 'analysis-live'
  | 'report-detail';

interface WorkspaceShellProps {
  activeTab: WorkspaceTab;
  breadcrumb: string;
  onNavigate: (tab: WorkspaceTab) => void;
  onReturnHome: () => void;
  primaryAction?: ReactNode;
  children: ReactNode;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'upload', label: 'New analysis', icon: Upload },
  { id: 'analyses', label: 'My analyses', icon: FolderSearch },
  { id: 'history', label: 'Detection history', icon: History },
  { id: 'reports', label: 'Reports', icon: FileBarChart2 },
  { id: 'datasets', label: 'Datasets', icon: Database },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function WorkspaceShell({
  activeTab,
  breadcrumb,
  onNavigate,
  onReturnHome,
  primaryAction,
  children,
}: WorkspaceShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isNavActive = (itemId: WorkspaceTab) => {
    if (activeTab === itemId) return true;
    if (activeTab === 'analysis-live' && itemId === 'analyses') return true;
    if (activeTab === 'report-detail' && itemId === 'reports') return true;
    return false;
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="h-16 px-5 flex items-center justify-between border-b border-[#DCE8F8]/80">
        <button
          type="button"
          onClick={onReturnHome}
          className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED] rounded-md"
        >
          <TruthLensLogo variant="light" />
        </button>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1.5 text-[#52607A] hover:text-[#0F172A] cursor-pointer"
          aria-label="Close navigation"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isNavActive(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onNavigate(item.id);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] whitespace-nowrap cursor-pointer ${
                active
                  ? 'bg-gradient-to-r from-[#EFF6FF] via-[#F3F0FF] to-[#EEF2FF] text-[#5B21B6] border border-[#DDD6FE]/80 shadow-[0_2px_10px_-4px_rgba(124,58,237,0.2)]'
                  : 'text-[#52607A] border border-transparent hover:bg-white/75 hover:text-[#0F172A] hover:border-[#DCE8F8]'
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#6D28D9]' : ''}`} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-[#DCE8F8]/80">
        <button
          type="button"
          onClick={onReturnHome}
          className="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium text-[#52607A] hover:text-[#0F172A] hover:bg-white/75 rounded-xl transition-colors cursor-pointer"
        >
          <Home className="w-4 h-4 shrink-0" />
          <span>Public homepage</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative z-10 min-h-screen text-[#0F172A] flex">
      {/* Desktop Frosted Glass Sidebar — Blends Into Continuous White/Pale-Blue Gradient */}
      <aside className="hidden lg:block w-[252px] shrink-0 bg-white/84 backdrop-blur-md border-r border-[#DCE8F8]/85 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[#0F172A]/25"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-[264px] max-w-[85vw] bg-white/95 h-full border-r border-[#DCE8F8] z-10">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Canvas */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 bg-white/84 backdrop-blur-md border-b border-[#DCE8F8]/85 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-[#52607A] hover:text-[#0F172A] cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-[#52607A] whitespace-nowrap">TruthLens</span>
              <span className="text-[#BFDBFE]" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-[#0F172A] truncate">{breadcrumb}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {primaryAction ?? (
              <PremiumButton
                variant="primary"
                size="md"
                onClick={() => onNavigate('upload')}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload media</span>
              </PremiumButton>
            )}
          </div>
        </header>

        <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-8 py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
