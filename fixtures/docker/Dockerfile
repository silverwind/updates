FROM node:18
RUN npm install
FROM --platform=linux/amd64 postgres:15-alpine
COPY . /app
FROM node:18 AS builder
RUN echo "build"
