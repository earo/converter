FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libheif-examples \
    ghostscript \
    pandoc \
    libreoffice \
    zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
