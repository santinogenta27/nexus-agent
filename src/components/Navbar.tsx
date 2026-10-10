import { Bot, Github, Layers, Network } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { HealthResponse } from '../types/agent';

export type TabId = 'simulator' | 'architecture';

const GITHUB_URL = 'https://github.com/santinogenta27/nexus-agent';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'simulator', label: 'Agent DAG', icon: Network },
  { id: 'architecture', label: 'System Architecture', icon: Layers },
];

interface NavbarProps {
  tab: TabId;
  onTabChange: (tab: TabId) => void;
  health: HealthResponse | null;
  healthError: boolean;
}

export default function Navbar({ tab, onTabChange, health, healthError }: NavbarProps) {
  const status = healthError
    ? { label: 'Server offline', dot: 'bg-rose-500' }
    : !health
      ? { label: 'Connecting…', dot: 'bg-slate-500' }
      : health.gemini.configured
        ? // A configured key is not proof that Gemini answers; per-run LLM mode is shown in the telemetry.
          { label: `Gemini key set · ${health.gemini.model}`, dot: 'bg-emerald-400' }
        : { label: 'Fallback engine', dot: 'bg-amber-400' };

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/15 ring-1 ring-indigo-400/40">
            <Bot className="h-4 w-4 text-indigo-300" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">NexusAgent</p>
            <p className="text-[11px] text-slate-500">Multi-agent research & execution</p>
          </div>
        </div>

        <nav className="order-3 flex w-full gap-1 overflow-x-auto scrollbar-thin md:order-none md:w-auto md:flex-1" aria-label="Sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div
            className="flex items-center gap-2 rounded-full border border-slate-800 px-3 py-1 text-xs text-slate-300"
            title={health ? `Genkit tools: ${health.genkit.tools.join(', ')} · CLI ${health.genkit.cliInstalled ? 'installed' : 'missing'} · ${health.rateLimit.usedLastMinute}/${health.rateLimit.rpm} RPM used` : undefined}
          >
            <span className={`h-2 w-2 rounded-full ${status.dot}`} />
            {status.label}
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:border-slate-500 hover:text-white"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
