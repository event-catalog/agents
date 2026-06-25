// Orders Service: owns the lifecycle of customer orders.
export class OrdersService {
  async confirmOrder(orderId) {
    return { orderId, orderStatus: 'confirmed' };
  }
}
