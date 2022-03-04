// Class representing a single hackable Server
import { BaseServer } from "./BaseServer";

import { BitNodeMultipliers } from "../BitNode/BitNodeMultipliers";

import { createRandomString } from "../utils/helpers/createRandomString";
import { createRandomIp } from "../utils/IPAddress";
import { Generic_fromJSON, Generic_toJSON, Reviver } from "../utils/JSONReviver";
import { Player } from "./Player";
import { calculateWeakenTime } from "./Hacking";
import { GetServer } from "./AllServers";

export interface IConstructorParams {
  adminRights?: boolean;
  hackDifficulty?: number;
  hostname: string;
  ip?: string;
  isConnectedTo?: boolean;
  maxRam?: number;
  moneyAvailable?: number;
  numOpenPortsRequired?: number;
  organizationName?: string;
  purchasedByPlayer?: boolean;
  requiredHackingSkill?: number;
  serverGrowth?: number;
  suppression?: number;
}

export class Server extends BaseServer {
  // Flag indicating whether this server has a backdoor installed by a player
  backdoorInstalled = false;

  // Initial server security level
  // (i.e. security level when the server was created)
  baseDifficulty = 1;

  // Server Security Level
  hackDifficulty = 1;

  // Minimum server security level that this server can be weakened to
  minDifficulty = 1;

  // How much money currently resides on the server and can be hacked
  moneyAvailable = 0;

  // Maximum amount of money that this server can hold
  moneyMax = 0;

  // Number of open ports required in order to gain admin/root access
  numOpenPortsRequired = 5;

  // How many ports are currently opened on the server
  openPortCount = 0;

  // Hacking level required to hack this server
  requiredHackingSkill = 1;

  // Parameter that affects how effectively this server's money can
  // be increased using the grow() Netscript function
  serverGrowth = 1;

  // Parameter that mitigates security increases from hack and grow operations
  suppression = 0;

  // Tracks the number of active suppression threads acting on this server
  activeSuppressionThreads: {hostname: string, threads: number}[] = [];

  // Suppression function interval ID
  suppressionIntervalID = 0;

  // Last time suppression was calculated
  suppressionLastUpdateTime = 0;

  constructor(params: IConstructorParams = { hostname: "", ip: createRandomIp() }) {
    super(params);

    // "hacknet-node-X" hostnames are reserved for Hacknet Servers
    if (this.hostname.startsWith("hacknet-node-")) {
      this.hostname = createRandomString(10);
    }

    this.purchasedByPlayer = params.purchasedByPlayer != null ? params.purchasedByPlayer : false;

    //RAM, CPU speed and Scripts
    this.maxRam = params.maxRam != null ? params.maxRam : 0; //GB

    /* Hacking information (only valid for "foreign" aka non-purchased servers) */
    this.requiredHackingSkill = params.requiredHackingSkill != null ? params.requiredHackingSkill : 1;
    this.moneyAvailable =
      params.moneyAvailable != null ? params.moneyAvailable * BitNodeMultipliers.ServerStartingMoney : 0;
    this.moneyMax = 25 * this.moneyAvailable * BitNodeMultipliers.ServerMaxMoney;

    //Hack Difficulty is synonymous with server security. Base Difficulty = Starting difficulty
    this.hackDifficulty =
      params.hackDifficulty != null ? params.hackDifficulty * BitNodeMultipliers.ServerStartingSecurity : 1;
    this.baseDifficulty = this.hackDifficulty;
    this.minDifficulty = Math.max(1, Math.round(this.hackDifficulty / 3));
    this.serverGrowth = params.serverGrowth != null ? params.serverGrowth : 1; //Integer from 0 to 100. Affects money increase from grow()

    //Port information, required for porthacking servers to get admin rights
    this.numOpenPortsRequired = params.numOpenPortsRequired != null ? params.numOpenPortsRequired : 5;
  }

  /**
   * Ensures that the server's difficulty (server security) doesn't get too high
   */
  capDifficulty(): void {
    if (this.hackDifficulty < this.minDifficulty) {
      this.hackDifficulty = this.minDifficulty;
    }
    if (this.hackDifficulty < 1) {
      this.hackDifficulty = 1;
    }

    // Place some arbitrarily limit that realistically should never happen unless someone is
    // screwing around with the game
    if (this.hackDifficulty > 100) {
      this.hackDifficulty = 100;
    }
  }

  /**
   * Change this server's minimum security
   * @param n - Value by which to increase/decrease the server's minimum security
   * @param perc - Whether it should be changed by a percentage, or a flat value
   */
  changeMinimumSecurity(n: number, perc = false): void {
    if (perc) {
      this.minDifficulty *= n;
    } else {
      this.minDifficulty += n;
    }

    // Server security cannot go below 1
    this.minDifficulty = Math.max(1, this.minDifficulty);
  }

  /**
   * Change this server's maximum money
   * @param n - Value by which to change the server's maximum money
   */
  changeMaximumMoney(n: number): void {
    const softCap = 10e12;
    if (this.moneyMax > softCap) {
      const aboveCap = this.moneyMax - softCap;
      n = 1 + (n - 1) / Math.log(aboveCap) / Math.log(8);
    }

    this.moneyMax *= n;
  }

  /**
   * Strengthens a server's security level (difficulty) by the specified amount,
   * mitigated by the server's suppression statistic if it is > 0 and reduces
   * suppression.
   */
  fortify(amt: number): void {
    this.hackDifficulty += amt * (1 - Math.min(this.suppression, 1));
    this.capDifficulty();

    // reduce suppression
    if (this.suppression > 0) {
      const suppressionFactor = this.getSuppressionFactor();
      if (suppressionFactor <= 0) {
        this.suppression = 0;
      } else {
        this.suppression -= (amt / suppressionFactor) / 2;
        this.suppression = Math.max(this.suppression, 0);
      }
    }
  }

  /**
   * Lowers the server's security level (difficulty) by the specified amount
   */
  weaken(amt: number): void {
    this.hackDifficulty -= amt * BitNodeMultipliers.ServerWeakenRate;
    this.capDifficulty();
  }

  /**
   * Increases the server's suppression level by the specified amount, limited
   * at 1.5
   */
  suppress(amt: number): void {
    this.suppress += amt;
    this.suppress = Math.min(this.suppress, 1.5);
  }

  /**
   * Add to this server's active suppression and kick of suppression updates if this is the
   * initial suppression attack
   */
  addSuppressionThreads(hostname: string, threads: number) {
    // Detect if we're starting to suppress this server and kick off suppression update
    if (this.activeSuppressionThreads.length === 0) {
      if (this.suppressionIntervalID !== 0) {
        console.error(`New suppression detected on ${this.hostname} but suppressionIntervalID is not 0`);
        clearInterval(this.suppressionIntervalID);
      } 
      this.suppressionLastUpdateTime = new Date().getTime();
      this.suppressionIntervalID = setInterval(this.doSuppressionUpdate, 200)
    }

    this.activeSuppressionThreads.push({hostname: hostname, threads: threads});
  }

  /**
   * Remove from this server's active supression thread collection and kill suppression updates if
   * there are no more active suppressions.
   */
  removeSuppressionThreads(hostname: string, threads: number) {
    if (this.activeSuppressionThreads.length === 0) {
      console.error(`Attepting to remove suppresion threads from ${this.hostname} where server hostname is ${
        hostname
      } and threads is ${threads}, but there are no active suppresion threads`);
      return;
    }

    const itemIndex = this.activeSuppressionThreads.findIndex(a => a.hostname === hostname && a.threads = threads);

    if (itemIndex === -1) {
      console.error(`Unable to find suppression item for ${this.hostname} where server hostname is ${hostname} and threads is ${threads}`);
      return;
    }

    this.activeSuppressionThreads.splice(itemIndex, 1);

    if (this.activeSuppressionThreads.length === 0) {
      if (this.suppressionIntervalID === 0) {
        console.error(`Suppression threads on ${this.hostname} have been reduced to 0 but suppressionIntervalID is 0`);
      }

      clearInterval(this.suppressionIntervalID);
      this.suppressionIntervalID = 0;
      this.suppressionLastUpdateTime = 0;
    }
  }

  /**
   * Update this server's suppression -- intended to be called by setInterval at a constant
   * rate as long as this server is being actively suppressed
   */
  doSuppressionUpdate(): void {
    const currentTime = new Date().getTime();
    const weakenTime = calculateWeakenTime(server, Player);
    const dT = currentTime - this.suppressionLastUpdateTime;
    this.suppress((dT / weakenTime) / 2);
    this.suppressionLastUpdateTime = currentTime;
  }

  /**
   * Returns a factor describing how much a server's suppression value will be reduced for a
   * given security increase where:
   *   suppression reduction = (security increase / suppression factor) / 2
   */
  getSuppressionFactor(): number {
    // collect number of active suppress threads, suppress threads from servers with 
    // cores > 1 are more effective, so they will count as more than 1
    let effectiveThreads = 0;
    for (const data of this.activeSuppressionThreads) {
      const server = GetServer(data.hostname);
      if (server === null) {
        console.error(`Unable to resolve server for suppression item ${data.hostname}:${data.threads}`);
        continue;
      }

      const coreBonus = 1 + (server.cpuCores - 1) / 16;
      effectiveThreads += coreBonus * data.threads;
    }

    return CONSTANTS.ServerWeakenAmount * effectiveThreads * BitNodeMultipliers.ServerWeakenRate;
  }

  /**
   * Clean up active suppression intervals if the server is sold or destroyed
   */
  destroy(): void {
    if (this.suppressionIntervalID !== 0) {
      clearInterval(this.suppressionIntervalID);
    }
  }

  /**
   * Serialize the current object to a JSON save state
   */
  toJSON(): any {
    return Generic_toJSON("Server", this);
  }

  // Initializes a Server Object from a JSON save state
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  static fromJSON(value: any): Server {
    const newServer: Server = Generic_fromJSON(Server, value.data);

    // Loaded servers are assumed to not be actively suppressed
    newServer.activeSuppressionThreads = 0;
    newServer.suppressionIntervalID = 0;
    newServer.suppressionLastUpdateTime = 0;

    return newServer;
  }
}

Reviver.constructors.Server = Server;
