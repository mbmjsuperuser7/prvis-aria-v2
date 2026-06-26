/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    DEFAULT_CUSTOMER_ID: process.env.DEFAULT_CUSTOMER_ID || 'demo-customer',
  },
}
module.exports = nextConfig
