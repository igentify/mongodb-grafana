FROM node:15.5.1-alpine3.12
ARG serviceversion=${serviceversion:-0.0.0}
ENV serviceversion ${serviceversion}

RUN apk add --update tini && \
    rm -rf /var/cache/apk/*

RUN mkdir -p /home/node/app
WORKDIR /home/node/app
COPY server/ package.json package-lock.json ./

RUN npm install --production

ENV NODE_ENV=production

EXPOSE 3333

# Tini is now available at /sbin/tini
ENTRYPOINT ["/sbin/tini", "--"]
# Run your program under Tini
CMD ["node", "/home/node/app/mongodb-proxy.js"]

USER node