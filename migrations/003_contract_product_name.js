export async function up(pgm) {
  const result = await pgm.db.query(
    'SELECT count(*)::int AS count FROM products WHERE display_name IS NULL',
  );
  if (result.rows[0].count !== 0) {
    throw new Error('CONTRACT_003_NULL_DISPLAY_NAME');
  }
  pgm.alterColumn('products', 'display_name', { notNull: true });
  pgm.dropColumn('products', 'name');
}

export const down = false;
