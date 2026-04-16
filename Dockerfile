FROM node:18-bullseye

RUN apt-get update && apt-get install -y ghostscript

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]