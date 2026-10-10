import { useEffect, useState } from 'react';
import type { HealthResponse } from './types/agent';
import Navbar from './components/Navbar';
import type { TabId } from './components/Navbar';
import AgentSimulator from './components/AgentSimulator';
import SystemArchitecture from './components/SystemArchitecture';

export default function App() {
  const [tab, setTab] = useState<TabId>('simulator');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(body);
          setHealthError(false);
        }
      } catch {
        if (!cancelled) setHealthError(true);
      }
    };
    void load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar tab={tab} onTabChange={setTab} health={health} healthError={healthError} />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* Simulator stays mounted so an in-flight run and its results survive tab switches. */}
        <div hidden={tab !== 'simulator'}>
          <AgentSimulator />
        </div>
        {tab === 'architecture' && <SystemArchitecture />}
      </main>
      <footer className="border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
        NexusAgent · Gemini + Genkit multi-agent reference implementation
      </footer>
    </div>
  );
}
