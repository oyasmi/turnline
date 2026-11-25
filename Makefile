.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

# Common settings (override via `make <target> VAR=value`)
PYTHON       ?= 3.13
UV           ?= uv
HOST         ?= 127.0.0.1
PORT         ?= 8686
AUTH         ?= passcode
SESSION_DAYS ?= 30
TTS_THREADS  ?= 2
DIRECT_ONLY  ?= 0
EXTRA_ARGS   ?=

# LAN / Public deployment settings
LAN_HOST         ?= $(shell ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($$i=="src"){print $$(i+1); exit}}' || hostname -I 2>/dev/null | awk '{print $$1}')
LAN_PORT         ?= $(PORT)
LAN_STATE_DIR    ?= $(HOME)/.local/state/turnline-lan
PUBLIC_URL       ?=
PUBLIC_PORT      ?= 8686
PUBLIC_STATE_DIR ?= $(HOME)/.local/state/turnline-public
PUBLIC_DAYS      ?= 14
TLS_CERT         ?=
TLS_KEY          ?=
STATE_DIR        ?=
PASSCODE_FILE    ?=

# Background script settings (`MODE=local|lan|public`)
MODE ?= lan

DIRECT_FLAG := $(if $(filter 1 true yes,$(DIRECT_ONLY)),--direct-only,)
STATE_FLAG  := $(if $(STATE_DIR),--state-dir "$(STATE_DIR)",)

.PHONY: help setup models run serve demo direct run-lan run-public \
	auth-set auth-status auth-revoke \
	start stop restart status logs \
	test test-py test-js test-browser test-ui test-all \
	android-debug android-release android-install

help: ## 显示帮助与常用命令
	@printf "\033[1mTurnline 常用命令\033[0m\n\n"
	@printf "\033[1m初始化与前台运行\033[0m\n"
	@printf "  \033[36mmake setup\033[0m             安装 Python 依赖并下载/校验本地语音模型\n"
	@printf "  \033[36mmake models\033[0m            仅下载或校验本地语音模型\n"
	@printf "  \033[36mmake run\033[0m               本机默认启动 (127.0.0.1:$(PORT)，中转本机 PipiClaw)\n"
	@printf "  \033[36mmake demo\033[0m              本机演示模式启动 (不依赖 PipiClaw)\n"
	@printf "  \033[36mmake direct\033[0m            本机纯直连模式启动 (--direct-only)\n"
	@printf "\n\033[1m内网与公网部署\033[0m\n"
	@printf "  \033[36mmake run-lan\033[0m           局域网自签 HTTPS 前台启动 (自动检测本机 IP + 口令保护)\n"
	@printf "  \033[36mmake run-public\033[0m        公网正式证书 HTTPS 前台启动 (需传 TLS_CERT 与 TLS_KEY)\n"
	@printf "  \033[36mmake auth-set\033[0m          设置或修改访问口令 (传 STATE_DIR=... 指定实例)\n"
	@printf "  \033[36mmake auth-status\033[0m       查看口令配置与已认证会话数\n"
	@printf "  \033[36mmake auth-revoke\033[0m       一键吊销所有已登录设备\n"
	@printf "\n\033[1m后台脚本运行 (scripts/service.sh，支持 MODE=local|lan|public)\033[0m\n"
	@printf "  \033[36mmake start\033[0m             后台启动服务\n"
	@printf "  \033[36mmake stop\033[0m              停止后台服务\n"
	@printf "  \033[36mmake restart\033[0m           重启后台服务\n"
	@printf "  \033[36mmake status\033[0m            查看后台服务状态\n"
	@printf "  \033[36mmake logs\033[0m              实时查看服务日志\n"
	@printf "\n\033[1m测试与 Android 构建\033[0m\n"
	@printf "  \033[36mmake test\033[0m              运行 Python 单测 + Node 协议测试\n"
	@printf "  \033[36mmake test-browser\033[0m      运行端到端浏览器语音与转发测试\n"
	@printf "  \033[36mmake test-ui\033[0m           运行 Playwright 界面截图与无障碍回归\n"
	@printf "  \033[36mmake test-all\033[0m          运行全部自动化测试\n"
	@printf "  \033[36mmake android-debug\033[0m     构建 Android Debug APK 并运行单测/Lint\n"
	@printf "  \033[36mmake android-install\033[0m   构建并通过 adb 安装 Debug APK 到手机\n"
	@printf "  \033[36mmake android-release\033[0m   构建未签名的 Android Release APK\n"
	@printf "\n\033[1m常用示例\033[0m\n"
	@printf "  make auth-set STATE_DIR=$(LAN_STATE_DIR)\n"
	@printf "  make start MODE=lan LAN_HOST=192.168.1.5\n"
	@printf "  make auth-set STATE_DIR=$(PUBLIC_STATE_DIR)\n"
	@printf "  make start MODE=public PUBLIC_PORT=8687 TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem\n"
	@printf "  make status MODE=public && make logs MODE=public\n"

setup: ## 安装 Python 依赖并下载语音模型
	$(UV) sync --locked --python $(PYTHON)
	$(UV) run python setup_models.py

models: ## 下载或校验本地语音模型
	$(UV) run python setup_models.py

run serve: ## 本机默认启动
	$(UV) run python server.py --host $(HOST) --port $(PORT) \
		--tts-threads $(TTS_THREADS) $(STATE_FLAG) $(DIRECT_FLAG) $(EXTRA_ARGS)

demo: ## 本机演示模式启动
	$(UV) run python server.py --demo --port $(PORT) --tts-threads $(TTS_THREADS) $(EXTRA_ARGS)

direct: ## 本机纯直连模式启动
	$(UV) run python server.py --direct-only --host $(HOST) --port $(PORT) \
		--tts-threads $(TTS_THREADS) $(STATE_FLAG) $(EXTRA_ARGS)

run-lan: ## 局域网自签 HTTPS 前台启动
	@url="$(PUBLIC_URL)"; \
	if [ -z "$$url" ]; then \
		if [ -z "$(LAN_HOST)" ]; then \
			echo "未能自动检测到局域网 IP，请指定 LAN_HOST=<IP> 或 PUBLIC_URL=https://<host>:<port>" >&2; \
			exit 1; \
		fi; \
		url="https://$(LAN_HOST):$(LAN_PORT)"; \
	fi; \
	state="$(or $(STATE_DIR),$(LAN_STATE_DIR))"; \
	exec $(UV) run python server.py --host 0.0.0.0 --port $(LAN_PORT) \
		--self-signed --public-url "$$url" \
		--state-dir "$$state" --auth $(AUTH) --session-days $(SESSION_DAYS) \
		--tts-threads $(TTS_THREADS) $(DIRECT_FLAG) $(EXTRA_ARGS)

run-public: ## 公网正式证书 HTTPS 前台启动
	@if [ -z "$(TLS_CERT)" ] || [ -z "$(TLS_KEY)" ]; then \
		echo "请指定 TLS_CERT 和 TLS_KEY，例如：" >&2; \
		echo "  make run-public TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem" >&2; \
		exit 1; \
	fi
	@state="$(or $(STATE_DIR),$(PUBLIC_STATE_DIR))"; \
	public_flag=""; \
	if [ -n "$(PUBLIC_URL)" ]; then public_flag="--public-url $(PUBLIC_URL)"; fi; \
	exec $(UV) run python server.py --host 0.0.0.0 --port $(PUBLIC_PORT) \
		--tls-cert "$(TLS_CERT)" --tls-key "$(TLS_KEY)" $$public_flag \
		--state-dir "$$state" --auth $(AUTH) --session-days $(PUBLIC_DAYS) \
		--tts-threads $(TTS_THREADS) $(DIRECT_FLAG) $(EXTRA_ARGS)

auth-set: ## 设置或修改访问口令
	$(UV) run python server.py auth set-passcode $(STATE_FLAG)

auth-status: ## 查看口令与已认证会话状态
	$(UV) run python server.py auth status $(STATE_FLAG)

auth-revoke: ## 一键吊销所有已认证会话
	$(UV) run python server.py auth revoke $(STATE_FLAG)

SERVICE_ARGS = --mode "$(MODE)" \
	$(if $(filter lan,$(MODE)),--port "$(LAN_PORT)" --state-dir "$(or $(STATE_DIR),$(LAN_STATE_DIR))" --session-days "$(SESSION_DAYS)",) \
	$(if $(filter public,$(MODE)),--port "$(PUBLIC_PORT)" --state-dir "$(or $(STATE_DIR),$(PUBLIC_STATE_DIR))" --session-days "$(PUBLIC_DAYS)",) \
	$(if $(filter local,$(MODE)),--host "$(HOST)" --port "$(PORT)" $(if $(STATE_DIR),--state-dir "$(STATE_DIR)",),) \
	$(if $(PUBLIC_URL),--public-url "$(PUBLIC_URL)",$(if $(and $(filter lan,$(MODE)),$(LAN_HOST)),--public-url "https://$(LAN_HOST):$(LAN_PORT)",)) \
	$(if $(TLS_CERT),--tls-cert "$(TLS_CERT)",) \
	$(if $(TLS_KEY),--tls-key "$(TLS_KEY)",) \
	$(if $(filter lan public,$(MODE)),--auth "$(AUTH)",) \
	$(if $(PASSCODE_FILE),--passcode-file "$(PASSCODE_FILE)",) \
	--tts-threads "$(TTS_THREADS)" $(DIRECT_FLAG)

start: ## 后台启动服务
	@./scripts/service.sh start $(SERVICE_ARGS)

stop: ## 停止后台服务
	@./scripts/service.sh stop --mode "$(MODE)" $(if $(STATE_DIR),--state-dir "$(STATE_DIR)",)

restart: ## 重启后台服务
	@./scripts/service.sh restart $(SERVICE_ARGS)

status: ## 查看后台服务状态
	@./scripts/service.sh status --mode "$(MODE)" $(if $(STATE_DIR),--state-dir "$(STATE_DIR)",)

logs: ## 实时查看后台服务日志
	@./scripts/service.sh logs --mode "$(MODE)" $(if $(STATE_DIR),--state-dir "$(STATE_DIR)",)

test: test-py test-js ## 运行 Python 单测与 Node 协议测试

test-py: ## 运行 Python 单元测试
	$(UV) run --no-sync python -m unittest discover -s test

test-js: ## 运行 Node 协议与状态机测试
	npm test

test-browser: ## 运行浏览器端到端语音与转发测试
	npm run test:browser

test-ui: ## 运行 Playwright 界面截图与无障碍测试
	npm run test:interface

test-all: test test-browser test-ui ## 运行全部自动化测试

android-debug: ## 构建 Android Debug APK 并执行单测/Lint
	cd clients/android && ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug

android-install: android-debug ## 安装 Debug APK 到连接的 Android 设备
	adb install -r clients/android/app/build/outputs/apk/debug/app-debug.apk

android-release: ## 构建未签名的 Android Release APK
	cd clients/android && ./gradlew :app:assembleRelease
