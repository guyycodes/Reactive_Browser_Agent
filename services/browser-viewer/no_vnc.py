# agent_sidecar_311/no_vnc.py
import asyncio
from typing import Optional

class NoVNCManager:
    """
    Minimal manager that starts/stops a noVNC process inside
    the container to provide an HTTP/WebSocket bridge to VNC.
    """

    def __init__(
        self,
        no_vnc_path: str = "/opt/novnc/utils/novnc_proxy",
        listen_host: str = "0.0.0.0",
        listen_port: int = 6080,
        vnc_host: str = "localhost",
        vnc_port: int = 5900,
    ):
        """
        :param no_vnc_path: The path to the noVNC "novnc_proxy" script.
        :param listen_host: Interface on which noVNC will listen for HTTP/websocket.
        :param listen_port: Port on which noVNC will listen for HTTP/websocket.
        :param vnc_host: The VNC server IP/host that noVNC should connect to.
        :param vnc_port: The VNC server port that noVNC should connect to.
        """
        self.no_vnc_path = no_vnc_path
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.vnc_host = vnc_host
        self.vnc_port = vnc_port

        self.process: Optional[asyncio.subprocess.Process] = None

    async def start_no_vnc(self) -> dict:
        """
        Launch the noVNC proxy process in the background.
        """
        if self.process and self.process.returncode is None:
            return {"status": "already_running"}

        cmd = [
            self.no_vnc_path,
            "--listen", f"{self.listen_host}:{self.listen_port}",
            "--vnc", f"{self.vnc_host}:{self.vnc_port}",
        ]

        try:
            self.process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            return {"status": "started"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    async def stop_no_vnc(self) -> dict:
        """
        Gracefully terminate noVNC if it's running.
        """
        if not self.process or self.process.returncode is not None:
            return {"status": "not_running"}

        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.communicate(), timeout=5)
        except asyncio.TimeoutError:
            self.process.kill()

        self.process = None
        return {"status": "stopped"}

    async def get_status(self) -> dict:
        """
        Returns whether noVNC is running or not.
        """
        if not self.process:
            return {"status": "stopped"}
        if self.process.returncode is None:
            return {"status": "running"}
        return {"status": "exited", "returncode": self.process.returncode}
