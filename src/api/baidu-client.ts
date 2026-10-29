import { FileTimes, remoteTime, writeTimes } from "../utils/timestamps";
import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { Mutex } from "../sync/queue";
import { RemoteFileInfo } from "../types";
import { calculateBlockList, calculateMd5 } from "../utils/crypto";

export interface BaiduTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export class BaiduClient {
  private tokenMutex = new Mutex();
  private appKey: string;
  private secretKey: string;
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt: number;
  private onTokenRefreshed?: (newToken: BaiduTokenResponse) => Promise<void>;

  constructor(options: {
    appKey: string;
    secretKey: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: number;
    onTokenRefreshed?: (newToken: BaiduTokenResponse) => Promise<void>;
  }) {
    this.appKey = options.appKey;
    this.secretKey = options.secretKey;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.tokenExpiresAt = options.tokenExpiresAt;
    this.onTokenRefreshed = options.onTokenRefreshed;
  }

  public updateCredentials(
    accessToken: string,
    refreshToken: string,
    tokenExpiresAt: number
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiresAt = tokenExpiresAt;
  }

  /**
   * Build OAuth authorization URL for user consent
   */
  public static getAuthUrl(appKey: string, redirectUri: string = "oob"): string {
    const base = "https://openapi.baidu.com/oauth/2.0/authorize";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: appKey,
      redirect_uri: redirectUri,
      scope: "basic,netdisk",
      display: "page",
    });
    return `${base}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   */
  public static async exchangeCodeForToken(
    code: string,
    appKey: string,
    secretKey: string,
    redirectUri: string = "oob"
  ): Promise<BaiduTokenResponse> {
    const url = "https://openapi.baidu.com/oauth/2.0/token";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      client_id: appKey.trim(),
      client_secret: secretKey.trim(),
      redirect_uri: redirectUri.trim(),
    });

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = res.json;
    if (data.error) {
      throw new Error(`Baidu Auth Error: ${data.error_description || data.error}`);
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
    };
  }

  /**
   * Refresh access token before expiration
   */
  private async ensureFreshToken(): Promise<string> {
    return this.tokenMutex.acquire(async () => {
      // If token expires within 5 minutes, refresh
      const now = Date.now();
      if (this.refreshToken && this.tokenExpiresAt && this.tokenExpiresAt - now < 300000) {
        try {
          const url = "https://openapi.baidu.com/oauth/2.0/token";
          const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.refreshToken,
            client_id: this.appKey,
            client_secret: this.secretKey,
          });

          const res = await requestUrl({
            url,
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
          });

          const data = res.json;
          if (!data.error && data.access_token) {
            this.accessToken = data.access_token;
            this.refreshToken = data.refresh_token || this.refreshToken;
            this.tokenExpiresAt = Date.now() + (data.expires_in || 2592000) * 1000;
            if (this.onTokenRefreshed) {
              await this.onTokenRefreshed({
                access_token: this.accessToken,
                refresh_token: this.refreshToken,
                expires_in: data.expires_in || 2592000,
                scope: data.scope || "",
              });
            }
          }
        } catch (err) {
          console.warn("Failed refreshing Baidu access token:", err);
        }
      }
      return this.accessToken;
    });
  }

  /**
   * Get user info from Baidu Netdisk (test connectivity)
   */
  public async getUserInfo(): Promise<{ baiduName: string; netdiskName: string; avatarUrl: string }> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token}`;
    
    const res = await requestUrl({
      url,
      method: "GET",
    });

    const data = res.json;
    if (data.errno !== 0) {
      throw new Error(`Failed to fetch user info: errno ${data.errno}`);
    }

    return {
      baiduName: data.baidu_name || "",
      netdiskName: data.netdisk_name || "",
      avatarUrl: data.avatar_url || "",
    };
  }

  /**
   * List files under remote directory (supports recursion and pagination)
   */
  public async listFiles(dirPath: string, recursion: boolean = true, shouldYield?:()=>boolean): Promise<RemoteFileInfo[]> {
    const token = await this.ensureFreshToken();
    const root = dirPath.replace(/\/$/, "") || "/";
    const directories = [root];
    const visited = new Set<string>();
    const result = new Map<string, RemoteFileInfo>();
    const limit = 1000;
    for (let cursor = 0; cursor < directories.length; cursor++) {
      const directory = directories[cursor];
      if (visited.has(directory)) continue;
      visited.add(directory);
      let start = 0;
      const pages = new Set<string>();
      while (true) {
        if(shouldYield?.()) throw new Error("SYNC_YIELD_FOR_CONFLICT");
        // method=list is single-directory only; recursion=1 is ignored by Baidu.
        const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(directory)}&start=${start}&limit=${limit}&web=1&access_token=${token}`;
        const data = (await requestUrl({url, method:"GET"})).json;
        if (data.errno === -9 && directory === root && start === 0) return [];
        if (data.errno !== 0 || !Array.isArray(data.list)) {
          throw new Error(`远端目录枚举不完整，已停止同步: ${directory} (errno: ${data.errno})`);
        }
        const signature = JSON.stringify(data.list.map((item: any) => item.path));
        if (data.list.length && pages.has(signature)) throw new Error("远端分页重复，已停止同步以防止误判删除");
        pages.add(signature);
        for (const item of data.list) {
          const prefix = directory === "/" ? "/" : directory + "/";
          if (typeof item.path !== "string" || !item.path.startsWith(prefix) ||
              !item.path.slice(prefix.length) || item.path.slice(prefix.length).includes("/")) {
            throw new Error("远端目录返回了越界文件，已停止同步");
          }
          result.set(item.path, {fsId:String(item.fs_id),path:item.path,
            serverFilename:item.server_filename,size:Number(item.size || 0),
            md5:item.md5 ? String(item.md5).toLowerCase() : undefined,
            localMtime:remoteTime(item.local_mtime),localCtime:remoteTime(item.local_ctime),
            serverMtime:Number(item.server_mtime || 0)*1000,isdir:Number(item.isdir || 0)});
          if (recursion && Number(item.isdir) === 1 && !visited.has(item.path)) directories.push(item.path);
        }
        // list often omits has_more. A full page requires another request.
        if (data.has_more !== 1 && data.list.length < limit) break;
        if (!data.list.length) throw new Error("远端分页缺少内容，已停止同步");
        start += data.list.length;
      }
    }
    return [...result.values()];
  }

  /**
   * Get direct download link (dlink) for a given fs_id
   */
  public async getDownloadLink(fsId: string): Promise<string> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[${fsId}]&dlink=1&access_token=${token}`;

    const res = await requestUrl({
      url,
      method: "GET",
    });

    const data = res.json;
    if (data.errno !== 0 || !data.list || !data.list[0] || !data.list[0].dlink) {
      throw new Error(`Failed to get dlink for fs_id ${fsId} (errno: ${data?.errno})`);
    }

    return data.list[0].dlink;
  }

  /**
   * Download file content as ArrayBuffer with proper User-Agent.
   * On mobile (and for large files), requests are safely chunked using HTTP Range
   * to avoid Capacitor's bridge Base64 OutOfMemoryError in Android ART.
   */
  public async downloadFile(
    fsId: string,
    expectedSize?: number,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<ArrayBuffer> {
    const token = await this.ensureFreshToken();
    const dlink = await this.getDownloadLink(fsId);
    
    // Baidu requires appending access_token to dlink and setting User-Agent: pan.baidu.com
    const downloadUrl = dlink.includes("?")
      ? `${dlink}&access_token=${token}`
      : `${dlink}?access_token=${token}`;

    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB safe chunk size for Capacitor base64 bridge

    // If expectedSize is known and small enough (<= 4MB), fetch directly in one request
    if (expectedSize !== undefined && expectedSize <= CHUNK_SIZE) {
      const res = await requestUrl({
        url: downloadUrl,
        method: "GET",
        headers: {
          "User-Agent": "pan.baidu.com",
        },
      });
      return res.arrayBuffer;
    }

    // Otherwise, use HTTP Range chunking to protect memory
    const firstEnd = expectedSize !== undefined ? Math.min(CHUNK_SIZE - 1, expectedSize - 1) : CHUNK_SIZE - 1;
    const firstRes = await requestUrl({
      url: downloadUrl,
      method: "GET",
      headers: {
        "User-Agent": "pan.baidu.com",
        "Range": `bytes=0-${firstEnd}`,
      },
    });

    if (firstRes.status === 200) {
      return firstRes.arrayBuffer;
    }

    if (firstRes.status !== 206) {
      throw new Error(`Failed to download file chunk (HTTP ${firstRes.status})`);
    }

    let totalSize = expectedSize;
    const contentRange = firstRes.headers?.["content-range"] || firstRes.headers?.["Content-Range"];
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) {
        totalSize = parseInt(match[1], 10);
      }
    }

    if (!totalSize || isNaN(totalSize)) {
      const fallbackRes = await requestUrl({
        url: downloadUrl,
        method: "GET",
        headers: { "User-Agent": "pan.baidu.com" },
      });
      return fallbackRes.arrayBuffer;
    }

    const firstBytes = new Uint8Array(firstRes.arrayBuffer);
    if (firstBytes.byteLength === totalSize) {
      return firstRes.arrayBuffer;
    }

    const result = new Uint8Array(totalSize);
    result.set(firstBytes, 0);
    let downloaded = firstBytes.byteLength;
    onProgress?.(downloaded, totalSize);

    while (downloaded < totalSize) {
      const end = Math.min(downloaded + CHUNK_SIZE - 1, totalSize - 1);
      const chunkRes = await requestUrl({
        url: downloadUrl,
        method: "GET",
        headers: {
          "User-Agent": "pan.baidu.com",
          "Range": `bytes=${downloaded}-${end}`,
        },
      });
      if (chunkRes.status !== 206 && chunkRes.status !== 200) {
        throw new Error(`Failed to download file chunk ${downloaded}-${end} (HTTP ${chunkRes.status})`);
      }
      const chunkBytes = new Uint8Array(chunkRes.arrayBuffer);
      result.set(chunkBytes, downloaded);
      downloaded += chunkBytes.byteLength;
      onProgress?.(downloaded, totalSize);
    }

    return result.buffer;
  }

  /**
   * Ensure remote directory exists
   */
  public async createDirectory(remotePath: string): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;
    
    const body = new URLSearchParams({
      path: remotePath,
      size: "0",
      isdir: "1",
      rtype: "0", // 0: return error if exists; 1: rename; 2: overwrite
    });

    try {
      const res = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const data = res.json;
      // errno -8 means file/dir already exists, which is acceptable
      if (data.errno !== 0 && data.errno !== -8) {
        console.warn(`Create dir "${remotePath}" returned errno ${data.errno}`);
      }
    } catch (e) {
      console.warn(`Error creating remote directory "${remotePath}":`, e);
    }
  }

  /**
   * Delete remote file or folder
   */
  public async deleteFile(remotePath: string): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${token}`;
    
    const body = new URLSearchParams({
      async: "0",
      filelist: JSON.stringify([remotePath]),
    });

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = res.json;
    if (data.errno !== 0 && data.errno !== -9) { // -9 means file does not exist
      throw new Error(`Failed to delete remote file "${remotePath}" (errno: ${data.errno})`);
    }
  }

  /** Synchronous batch request; only explicit per-path acknowledgements commit. */
  public async deleteFiles(paths: string[]): Promise<Map<string, string | undefined>> {
    if (!paths.length) return new Map();
    if (paths.length > 50 || new Set(paths).size !== paths.length) throw new Error("删除批次必须为 1–50 个不同路径");
    const token = await this.ensureFreshToken();
    const res = await requestUrl({
      url: `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${token}`,
      method: "POST", headers: {"Content-Type":"application/x-www-form-urlencoded"},
      body: new URLSearchParams({async:"0",filelist:JSON.stringify(paths)}).toString(),
    });
    const data = res.json;
    const result = new Map<string,string|undefined>();
    for (const path of paths) {
      const items = Array.isArray(data.info) ? data.info.filter((x:any)=>x.path===path) : [];
      const item = items.length === 1 ? items[0] : undefined;
      result.set(path, item && (item.errno === 0 || item.errno === -9)
        ? undefined : `删除结果未确认 (总 errno: ${data.errno}, 文件 errno: ${item?.errno ?? "missing"})`);
    }
    return result;
  }

  /**
   * Upload file to Baidu Netdisk using 2-phase atomic commit
   * (Precreate -> upload parts -> create commit)
   */
  public async uploadFile(
    remotePath: string,
    fileBuffer: ArrayBuffer | Uint8Array,
    times?: FileTimes
  ): Promise<{ fsId: string; md5: string }> {
    const token = await this.ensureFreshToken();
    const bytes =
      fileBuffer instanceof Uint8Array
        ? fileBuffer
        : new Uint8Array(fileBuffer);
    const { blockList, chunks } = calculateBlockList(bytes);
    const blockListJson = JSON.stringify(blockList);
    const clientTimes: Record<string,string> = {};
    for (const [name,value] of Object.entries(writeTimes(times))) clientTimes[`local_${name}`] = String(Math.floor(value! / 1000));

    // Phase 1: Precreate
    const precreateUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${token}`;
    const precreateBody = new URLSearchParams({
      path: remotePath,
      size: String(bytes.length),
      isdir: "0",
      autoinit: "1",
      rtype: "3", // Overwrite on conflict
      block_list: blockListJson,
      ...clientTimes,
    });

    const precreateRes = await requestUrl({
      url: precreateUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: precreateBody.toString(),
    });

    const precreateData = precreateRes.json;
    if (precreateData.errno !== 0) {
      throw new Error(
        `Precreate failed for "${remotePath}" (errno: ${precreateData.errno}, msg: ${precreateData.show_msg || ""})`
      );
    }

    const uploadid = precreateData.uploadid;

    // Baidu return_type=1 requires missing parts; return_type=2 is rapid
    // upload. Never commit an unuploaded block list (previously caused 31500).
    if (precreateData.return_type === 2) {
      if (!precreateData.info?.fs_id && !precreateData.fs_id) {
        throw new Error("Rapid upload response missing committed file metadata");
      }
      const info = precreateData.info || precreateData;
      return { fsId: String(info.fs_id), md5: info.md5 || calculateMd5(bytes) };
    }
    if (precreateData.return_type !== 1 || !uploadid) {
      throw new Error("Invalid precreate response: no valid upload session");
    }
    const missingParts: number[] = precreateData.block_list;
    if (!Array.isArray(missingParts) || missingParts.some(index =>
      !Number.isInteger(index) || index < 0 || index >= chunks.length)) {
      throw new Error("Invalid precreate missing-block list");
    }
    for (const partseq of missingParts) {
      await this.uploadChunk(remotePath, uploadid, partseq, chunks[partseq]);
    }

    // Phase 3: Create (atomic final commit)
    const createUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;
    const createBody = new URLSearchParams({
      path: remotePath,
      size: String(bytes.length),
      isdir: "0",
      rtype: "3",
      uploadid: uploadid,
      block_list: blockListJson,
      ...clientTimes,
    });

    const createRes = await requestUrl({
      url: createUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: createBody.toString(),
    });

    const createData = createRes.json;
    if (createData.errno !== 0) {
      throw new Error(
        `Atomic commit (create) failed for "${remotePath}" (errno: ${createData.errno})`
      );
    }

    if (!createData.fs_id || (createData.size !== undefined && Number(createData.size) !== bytes.length)) {
      throw new Error("Commit response missing valid file metadata");
    }
    return {
      fsId: String(createData.fs_id),
      md5: createData.md5 || calculateMd5(bytes),
    };
  }

  /**
   * Upload single block using PCS superfile2 multipart/form-data
   * Cross-platform without Buffer dependency.
   */
  private async uploadChunk(
    remotePath: string,
    uploadid: string,
    partseq: number,
    chunkBytes: Uint8Array
  ): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&path=${encodeURIComponent(
      remotePath
    )}&uploadid=${uploadid}&partseq=${partseq}&access_token=${token}`;

    const boundary = "----BaiduNetdiskFormBoundary" + Math.random().toString(36).substring(2);
    
    // Construct multipart payload using TextEncoder and Uint8Array
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk_${partseq}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    
    const totalLength = prefix.length + chunkBytes.length + suffix.length;
    const multipartBody = new Uint8Array(totalLength);
    multipartBody.set(prefix, 0);
    multipartBody.set(chunkBytes, prefix.length);
    multipartBody.set(suffix, prefix.length + chunkBytes.length);

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody.buffer.slice(
        multipartBody.byteOffset,
        multipartBody.byteOffset + multipartBody.byteLength
      ),
    });

    const data = res.json;
    if (data.errno && data.errno !== 0) {
      throw new Error(`Upload chunk ${partseq} failed (errno: ${data.errno})`);
    }
  }
}
