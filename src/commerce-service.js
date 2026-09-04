export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

export class ProductNotFoundError extends Error {
  constructor(productId) {
    super(`product not found: ${productId}`);
    this.name = 'ProductNotFoundError';
    this.statusCode = 404;
  }
}

export class OrderNotFoundError extends Error {
  constructor(orderId) {
    super(`order not found: ${orderId}`);
    this.name = 'OrderNotFoundError';
    this.statusCode = 404;
  }
}

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('database unavailable');
    this.name = 'DatabaseUnavailableError';
    this.statusCode = 503;
  }
}

export class InsufficientStockError extends Error {
  constructor(productId, requested, available) {
    super(`insufficient stock for product ${productId}: requested=${requested}, available=${available}`);
    this.name = 'InsufficientStockError';
    this.statusCode = 409;
  }
}

function readProductId(raw) {
  const productId = Number(raw);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new ValidationError('productId must be a positive integer');
  }
  return productId;
}

function normalizeOrderInput(input) {
  const idempotencyKey = input?.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ValidationError('Idempotency-Key must contain between 1 and 128 characters');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ValidationError('items must be a non-empty array');
  }

  const quantities = new Map();
  for (const item of input.items) {
    const productId = readProductId(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
      throw new ValidationError('quantity must be an integer between 1 and 100');
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }

  return {
    idempotencyKey,
    items: [...quantities.entries()]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((left, right) => left.productId - right.productId),
  };
}

export function calculateOrderTotal(orderItems) {
  return orderItems.reduce(
    (total, item) => total + (item.unitPriceCents * item.quantity),
    0,
  );
}

export function createCommerceService(repository, { metrics } = {}) {
  if (!repository) throw new TypeError('commerce repository is required');

  return {
    listProducts() {
      return repository.listProducts().catch(() => {
        throw new DatabaseUnavailableError();
      });
    },

    getInventory(rawProductId) {
      return repository.getInventory(readProductId(rawProductId)).catch((error) => {
        if (error instanceof ProductNotFoundError) throw error;
        throw new DatabaseUnavailableError();
      });
    },

    getOrder(rawOrderId) {
      return repository.getOrder(readProductId(rawOrderId)).catch((error) => {
        if (error instanceof OrderNotFoundError) throw error;
        throw new DatabaseUnavailableError();
      });
    },

    isReady() {
      return repository.isReady();
    },

    async createOrder(input) {
      const normalized = normalizeOrderInput(input);

      try {
        const order = await repository.withTransaction(async (transaction) => {
        await transaction.advisoryLock(normalized.idempotencyKey);
        const existing = await transaction.findOrderByIdempotencyKey(normalized.idempotencyKey);
        if (existing) return existing;

        const productIds = normalized.items.map((item) => item.productId);
        const inventoryRows = await transaction.lockInventory(productIds);
        const inventoryByProduct = new Map(inventoryRows.map((row) => [row.productId, row]));

        const orderItems = normalized.items.map((item) => {
          const inventory = inventoryByProduct.get(item.productId);
          if (!inventory) throw new ProductNotFoundError(item.productId);
          if (inventory.availableQuantity < item.quantity) {
            throw new InsufficientStockError(
              item.productId,
              item.quantity,
              inventory.availableQuantity,
            );
          }
          return {
            productId: item.productId,
            sku: inventory.sku,
            name: inventory.name,
            unitPriceCents: inventory.priceCents,
            quantity: item.quantity,
          };
        });

        const totalCents = calculateOrderTotal(orderItems);
        const order = await transaction.insertOrder({
          idempotencyKey: normalized.idempotencyKey,
          status: 'CONFIRMED',
          totalCents,
        });

        for (const item of orderItems) {
          await transaction.insertOrderItem({ orderId: order.id, ...item });
          await transaction.decrementInventory(item.productId, item.quantity);
        }

        return { ...order, items: orderItems };
        });
        metrics?.orderCreated();
        return order;
      } catch (error) {
        if (error instanceof InsufficientStockError) metrics?.inventoryConflict();
        metrics?.orderFailed?.(error instanceof InsufficientStockError ? 'insufficient_stock' : 'database');
        if (error instanceof ValidationError || error instanceof ProductNotFoundError
          || error instanceof InsufficientStockError) throw error;
        throw new DatabaseUnavailableError();
      }
    },
  };
}
