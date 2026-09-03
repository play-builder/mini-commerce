export async function up(pgm) {
  pgm.createTable('products', {
    id: { type: 'bigserial', primaryKey: true },
    sku: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    price_cents: { type: 'integer', notNull: true, check: 'price_cents >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });

  pgm.createTable('inventory', {
    product_id: {
      type: 'bigint',
      primaryKey: true,
      references: 'products',
      onDelete: 'RESTRICT',
    },
    available_quantity: {
      type: 'integer',
      notNull: true,
      default: 0,
      check: 'available_quantity >= 0',
    },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });

  pgm.createTable('orders', {
    id: { type: 'bigserial', primaryKey: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true, default: 'CONFIRMED' },
    total_cents: { type: 'integer', notNull: true, check: 'total_cents >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });

  pgm.createTable('order_items', {
    id: { type: 'bigserial', primaryKey: true },
    order_id: { type: 'bigint', notNull: true, references: 'orders', onDelete: 'CASCADE' },
    product_id: { type: 'bigint', notNull: true, references: 'products', onDelete: 'RESTRICT' },
    sku: { type: 'text', notNull: true },
    product_name: { type: 'text', notNull: true },
    unit_price_cents: { type: 'integer', notNull: true, check: 'unit_price_cents >= 0' },
    quantity: { type: 'integer', notNull: true, check: 'quantity > 0' },
  });
  pgm.createIndex('order_items', 'order_id');

  pgm.sql(`
    INSERT INTO products (id, sku, name, price_cents) VALUES
      (1, 'COURSE-LAPTOP', 'Course Laptop', 129900),
      (2, 'COURSE-MOUSE', 'Course Mouse', 3900),
      (3, 'COURSE-KEYBOARD', 'Course Keyboard', 7900),
      (4, 'COURSE-MONITOR', 'Course Monitor', 32900)
    ON CONFLICT (sku) DO UPDATE SET
      name = EXCLUDED.name,
      price_cents = EXCLUDED.price_cents;

    INSERT INTO inventory (product_id, available_quantity)
    SELECT id, 20 FROM products
    ON CONFLICT (product_id) DO NOTHING;

    SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT MAX(id) FROM products));
  `);
}

export const down = false;
