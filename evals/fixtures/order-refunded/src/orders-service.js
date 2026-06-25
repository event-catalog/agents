import { messages } from './contracts/messages.js';

// Orders Service: owns the lifecycle of customer orders.
export class OrdersService {
  async confirmOrder(orderId) {
    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId, orderStatus: 'confirmed' });
  }

  async #publishDomainEvent(message, payload) {
    // ...publish to the domain event bus
    return { message, payload };
  }
}
