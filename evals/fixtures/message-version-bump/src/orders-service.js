import { messages } from './contracts/messages.js';

export class OrdersService {
  #publisher;

  constructor(publisher) {
    this.#publisher = publisher;
  }

  async confirmOrder(order) {
    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId: order.id, totalAmount: order.total });
  }

  async #publishDomainEvent(message, payload) {
    return this.#publisher.publish({ ...message, payload });
  }
}
