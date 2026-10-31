/** Connection used by tests. Override with TEST_DATABASE_URL; never points at the development database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://root:tero_dev_root@localhost:3306/tero_test';

export const TEST_ADMIN = { email: 'admin@test.local', password: 'correct-horse-battery-staple' };
