import { connect } from '@example/postgres';

export const db = connect(process.env.PRODUCT_DATABASE_URL);
