import type { Domain } from '../types/agent';

/** Example inputs for the UI. They only prefill the form; all findings come from live research. */
export interface ExampleInput {
  id: string;
  label: string;
  company: string;
  url: string;
  domain: Domain;
  goal: string;
}

export const EXAMPLES: ExampleInput[] = [
  {
    id: 'stripe',
    label: 'Stripe',
    company: 'Stripe',
    url: 'https://stripe.com',
    domain: 'fintech',
    goal: 'Assess how clearly Stripe communicates its value proposition and pricing to startups, and where its onboarding could create friction for small businesses.',
  },
  {
    id: 'linear',
    label: 'Linear',
    company: 'Linear',
    url: 'https://linear.app',
    domain: 'saas',
    goal: 'Evaluate Linear\'s positioning, plan structure and self-serve adoption path for growing engineering teams.',
  },
  {
    id: 'churn',
    label: 'Churn signals (name only)',
    company: 'Notion',
    url: '',
    domain: 'saas',
    goal: 'Identify public signals that could indicate churn risk for Notion among small teams, separating provisional signals from confirmed facts.',
  },
];
