import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2] || '/opt/kin-gateway/data/kin.db', { readOnly: true })

const acc = db.prepare(`
  SELECT vm_id,
         json_extract(unified_json, '$.7d.utilization') AS u7,
         json_extract(unified_json, '$.7d.status') AS s7,
         json_extract(unified_json, '$.7d_oi.utilization') AS uoi,
         json_extract(unified_json, '$.7d_oi.status') AS soi,
         json_extract(unified_json, '$.5h.utilization') AS u5
  FROM accounts
`).all()

const logs = db.prepare(`
  SELECT
    CASE
      WHEN model LIKE '%fable%' OR upstream_model LIKE '%fable%' THEN 'fable'
      WHEN model LIKE '%opus%' OR upstream_model LIKE '%opus%' THEN 'opus'
      WHEN model LIKE '%sonnet%' OR upstream_model LIKE '%sonnet%' THEN 'sonnet'
      WHEN model LIKE '%haiku%' OR upstream_model LIKE '%haiku%' THEN 'haiku'
      ELSE 'other'
    END AS fam,
    COUNT(*) AS n,
    ROUND(SUM(COALESCE(total_cost,0)),4) AS cost,
    SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0)) AS toks
  FROM request_logs
  WHERE ts >= datetime('now', '-7 days')
  GROUP BY fam
  ORDER BY cost DESC
`).all()

console.log(JSON.stringify({ quota: acc, last7d_by_family: logs }, null, 2))
db.close()
