FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

# State directory for bandit persistence
RUN mkdir -p .swarm

CMD ["node", "src/index.js"]
