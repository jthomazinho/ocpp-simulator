FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY simulator.js dashboard.html ./

EXPOSE 3100

CMD ["node", "simulator.js"]
