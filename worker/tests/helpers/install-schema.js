// D1.exec treats each input line as one SQL upload and caps it at 100,000 bytes.
// Keep complete trigger bodies together; never split on internal semicolons.
export function schemaUploadChunks(schema) {
  return schema.split('\n-- Migration 052:').map((part, index) => {
    if (index) part = '-- Migration 052:' + part;
    const sql = part.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\r?\n/g,
      token => token.startsWith('--') || /^\r?\n$/.test(token) ? ' ' : token);
    if (Buffer.byteLength(sql) >= 100000) throw Error('schema_upload_too_large');
    return sql;
  });
}
export async function installTestSchema(db, schema) {
  for (const chunk of schemaUploadChunks(schema)) await db.exec(chunk);
}
