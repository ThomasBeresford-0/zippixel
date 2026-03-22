FROM node:20-bookworm

WORKDIR /opt/render/project/src

RUN apt-get update && apt-get install -y qpdf && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 4242

CMD ["npm", "start"]