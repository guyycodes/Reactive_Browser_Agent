# agent_sidecar_311/main.py

import asyncio
import logging

from side_car import SocatManager
from no_vnc import NoVNCManager

# Configure root logger. You can adjust level, format, etc.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

async def main():
    logger.info("Starting sidecar services...")

    socat_manager = SocatManager(
        listen_port=5900,
        forward_host="agent",
        forward_port=5900
    )

    no_vnc_manager = NoVNCManager(
        no_vnc_path="/opt/novnc/utils/novnc_proxy",
        listen_host="0.0.0.0",
        listen_port=6080,
        vnc_host="localhost",
        vnc_port=5900
    )

    # Start socat
    result_start_socat = await socat_manager.start_socat()
    logger.info("Start socat: %s", result_start_socat)

    # Start noVNC
    result_start_no_vnc = await no_vnc_manager.start_no_vnc()
    logger.info("Start noVNC: %s", result_start_no_vnc)

    # Check statuses
    logger.info("Socat status: %s", await socat_manager.get_status())
    logger.info("noVNC status: %s", await no_vnc_manager.get_status())

    # Keep running until interrupted
    try:
        logger.info("Sidecar running. Press Ctrl+C to stop.")
        while True:
            await asyncio.sleep(5)
    except KeyboardInterrupt:
        logger.info("Shutting down sidecar services...")

    # Stop noVNC
    result_stop_no_vnc = await no_vnc_manager.stop_no_vnc()
    logger.info("Stop noVNC: %s", result_stop_no_vnc)

    # Stop socat
    result_stop_socat = await socat_manager.stop_socat()
    logger.info("Stop socat: %s", result_stop_socat)

if __name__ == "__main__":
    asyncio.run(main())
