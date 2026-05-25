FROM node:20-alpine

EXPOSE 3000

WORKDIR /app
COPY . .

# Install ALL dependencies - the build needs devDependencies (vite, typescript).
# NODE_ENV is intentionally left unset here so npm does not skip devDependencies.
RUN npm install

# Build the Remix app (vite:build).
RUN npm run build

# Runtime environment. Set after the build so it does not affect `npm install`.
ENV NODE_ENV=production

CMD ["npm", "run", "docker-start"]
