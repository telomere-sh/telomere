ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
USER 10001:10001
ENV NODE_ENV=production
# The operator injects the fixed task program and JSON stdin through DockerCpuExecutor.
# No Docker socket, host directories, secrets, package install, or task-selected command.
