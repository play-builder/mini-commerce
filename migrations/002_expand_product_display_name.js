export async function up(pgm) {
  pgm.addColumn('products', {
    display_name: { type: 'text' },
  });
  pgm.sql(`
    UPDATE products
    SET display_name = name
    WHERE display_name IS NULL;
  `);
}
