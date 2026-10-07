import type { QueryResult, QueryResultRow } from 'pg';

/** A pool or a transaction's client: anything a repository can query through. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}
