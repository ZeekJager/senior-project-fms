import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from './registry';

/** The Core Web Vitals the web app reports (FMS-75, docs/metrics.md). */
export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];
export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type WebVitalRating = (typeof WEB_VITAL_RATINGS)[number];

/** At most this many distinct `page` labels; later ones count under `other`, so a client cannot make a series per URL. */
export const MAX_WEB_VITAL_PAGES = 100;
export const OTHER_PAGE = 'other';

/**
 * Buckets around Google's thresholds for good / poor, in the metric's unit (seconds for the times, a score for CLS):
 * LCP 2.5 s / 4 s, INP 200 ms / 500 ms, CLS 0.1 / 0.25, FCP 1.8 s / 3 s, TTFB 0.8 s / 1.8 s.
 */
const BUCKETS: Record<WebVitalName, number[]> = {
  LCP: [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10],
  INP: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2],
  CLS: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
  FCP: [0.5, 1, 1.8, 2.5, 3, 5],
  TTFB: [0.2, 0.4, 0.8, 1.2, 1.8, 3],
};

const histogram = (name: WebVitalName, metric: string, help: string) =>
  new Histogram({ name: metric, help, labelNames: ['page'] as const, buckets: BUCKETS[name], registers: [metricsRegistry] });

const histograms: Record<WebVitalName, Histogram<'page'>> = {
  LCP: histogram('LCP', 'web_vitals_lcp_seconds', 'Largest Contentful Paint of real sessions, by page template'),
  INP: histogram('INP', 'web_vitals_inp_seconds', 'Interaction to Next Paint of real sessions, by page template'),
  CLS: histogram('CLS', 'web_vitals_cls', 'Cumulative Layout Shift score of real sessions, by page template'),
  FCP: histogram('FCP', 'web_vitals_fcp_seconds', 'First Contentful Paint of real sessions, by page template'),
  TTFB: histogram('TTFB', 'web_vitals_ttfb_seconds', 'Time to First Byte of real sessions, by page template'),
};

const ratings = new Counter({
  name: 'web_vitals_ratings_total',
  help: 'Web vitals reported, by metric and the rating the browser gave (good, needs-improvement, poor)',
  labelNames: ['metric', 'rating'] as const,
  registers: [metricsRegistry],
});

const knownPages = new Set<string>();

/** The page label to use: the template the client sent, until there are too many distinct ones. */
export function pageLabel(page: string | undefined): string {
  if (!page) return OTHER_PAGE;
  if (knownPages.has(page)) return page;
  if (knownPages.size >= MAX_WEB_VITAL_PAGES) return OTHER_PAGE;
  knownPages.add(page);
  return page;
}

/** Records one report. The times arrive in milliseconds and are stored in seconds (Prometheus' base unit); CLS is a score. */
export function recordWebVital(report: { name: WebVitalName; value: number; rating: WebVitalRating; page?: string }): void {
  const value = report.name === 'CLS' ? report.value : report.value / 1000;
  histograms[report.name].observe({ page: pageLabel(report.page) }, value);
  ratings.inc({ metric: report.name, rating: report.rating });
}

/** For tests: forget the pages seen, so the cap can be reached again. */
export function forgetWebVitalPages(): void {
  knownPages.clear();
}
