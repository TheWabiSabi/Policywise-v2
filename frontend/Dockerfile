# Build stage
FROM node:20-alpine as build

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy all files
COPY . .

# Build the frontend application
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built assets to Nginx html directory
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx config for React Router
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port (Nginx default is 80)
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
