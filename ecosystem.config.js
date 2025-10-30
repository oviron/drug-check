module.exports = {
  apps: [{
    name: 'drugs-bot',
    script: 'index.ts',
    interpreter: 'ts-node',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    log_file: './app.log',
    error_file: './app.log',
    time: true
  }]
}
