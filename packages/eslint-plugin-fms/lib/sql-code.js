/**
 * The parts of a SQL text that are code: string literals, dollar-quoted
 * bodies and comments are replaced by a space, so a value such as
 * 'fleet.depots' or a comment naming a table is not read as a table, and a
 * `--` inside a value does not hide the rest of the line.
 *
 * One left-to-right pass, as PostgreSQL reads it:
 * - '...' with '' as an escaped quote, and E'...' where \ also escapes;
 * - $tag$...$tag$ and $$...$$ (a `$1` placeholder is not a dollar quote);
 * - -- to the end of the line, and nested /* ... *\/ comments.
 * "Quoted identifiers" are code and are kept.
 */
function sqlCode(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += ' ';
    } else if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        out += ' ';
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

module.exports = { sqlCode };
