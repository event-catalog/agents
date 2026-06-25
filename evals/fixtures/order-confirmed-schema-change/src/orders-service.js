import { messages } from './contracts/messages.js';

// Orders Service: owns the lifecycle of customer orders.
export class OrdersService {
  async confirmOrder(orderId, currency) {
    // The PR adds `currency` to the OrderConfirmed payload (see scenario diff).
    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId, orderStatus: 'confirmed', currency });
  }

  async #publishDomainEvent(message, payload) {
    // ...publish to the domain event bus
    return { message, payload };
  }
}
