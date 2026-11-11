# 由 fnos/build.sh 生成的 rootfs.tar.gz 是 MiScreen 镜像（见项目根目录 Dockerfile）的完整文件系统
FROM scratch
ADD rootfs.tar.gz /
WORKDIR /app
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    HOME=/data \
    DATA_DIR=/data \
    PORT=8080 \
    HTTPS_PORT=8443
EXPOSE 8080 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
